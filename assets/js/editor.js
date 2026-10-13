(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const fileInput = $("fileInput"), mergeInput = $("mergeInput"), imageInput = $("imageInput");
  const pdfCanvas = $("pdfCanvas"), noteCanvas = $("annotationCanvas");
  const noteCtx = noteCanvas.getContext("2d");
  const viewportHost = $("pageViewport"), stack = $("pageStack");
  let pdfDocument = null, sourceBytes = null, sourceName = "document.pdf";
  let currentPage = 1, zoom = 1, viewport = null, activeTool = "select";
  let removed = new Set(), rotations = {}, edits = {}, undoStack = [], redoStack = [];
  let gesture = null, imagePoint = null, busy = false, installPrompt = null, toastTimer = null;

  // Persist the current document and edits locally so a refresh does not lose work.
  const LOCAL_DB = "editora-local-workspace";
  const LOCAL_STORE = "workspace";
  let autosaveTimer = null;
  function openLocalDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(LOCAL_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(LOCAL_STORE)) request.result.createObjectStore(LOCAL_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function localDbAction(mode, action) {
    const db = await openLocalDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(LOCAL_STORE, mode);
      const store = tx.objectStore(LOCAL_STORE);
      let req;
      try { req = action(store); } catch (error) { db.close(); reject(error); return; }
      tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
      tx.onerror = () => { db.close(); reject(tx.error || (req && req.error)); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error("Local save aborted")); };
    });
  }
  function scheduleAutosave() {
    if (!sourceBytes) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(async () => {
      try {
        await localDbAction("readwrite", store => store.put({
          bytes: sourceBytes,
          name: sourceName,
          currentPage,
          zoom,
          removed: Array.from(removed),
          rotations,
          edits,
          savedAt: Date.now()
        }, "current"));
        $("statusText").textContent = "Saved locally · refresh-safe";
      } catch (error) {
        console.warn("Editora local autosave failed", error);
        toast("Could not autosave locally. Download your PDF to keep a copy.", 5000);
      }
    }, 450);
  }
  async function restoreLocalWorkspace() {
    try {
      const saved = await localDbAction("readonly", store => store.get("current"));
      if (!saved || !saved.bytes) return;
      const bytes = saved.bytes instanceof Uint8Array ? saved.bytes : new Uint8Array(saved.bytes);
      const parsed = await pdfjsLib.getDocument({data: bytes.slice()}).promise;
      pdfDocument = parsed;
      sourceBytes = bytes;
      sourceName = saved.name || "document.pdf";
      currentPage = Math.max(1, Math.min(parsed.numPages, Number(saved.currentPage) || 1));
      zoom = Math.max(.5, Math.min(2.6, Number(saved.zoom) || 1));
      removed = new Set(saved.removed || []);
      rotations = saved.rotations || {};
      edits = saved.edits || {};
      undoStack = []; redoStack = [];
      $("welcome").classList.add("hidden");
      $("editorView").classList.remove("hidden");
      $("documentName").textContent = sourceName;
      $("documentMeta").textContent = sizeLabel(bytes.byteLength) + " · restored local document";
      $("sideFileName").textContent = sourceName;
      $("sideFileSize").textContent = sizeLabel(bytes.byteLength);
      refreshPageInfo();
      await renderPage();
      toast("Your previous PDF and edits were restored from this device.");
    } catch (error) {
      console.warn("Editora local restore failed", error);
      toast("Could not restore the previous PDF. Open it again from your device.", 5000);
    }
  }
  const hints = {
    select: "Navigate the page. Choose a tool to edit.",
    text: "Tap or click where the text should start.",
    replace: "Drag over the area to cover, then enter replacement text.",
    highlight: "Drag over a line or paragraph to highlight it.",
    draw: "Press and drag to draw freehand.",
    image: "Tap or click where you want the image, then choose a PNG/JPG.",
    signature: "Draw your signature with a mouse or finger."
  };

  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  function toast(message, ms = 3200) {
    $("toast").textContent = message;
    $("toast").classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $("toast").classList.remove("show"), ms);
  }
  function status(message) {
    $("statusText").textContent = message;
    $("pageState").textContent = message;
  }
  function setBusy(value, title = "Working on your PDF…", detail = "Please keep this tab open.") {
    busy = value;
    $("busyLayer").classList.toggle("hidden", !value);
    $("busyTitle").textContent = title;
    $("busyDetail").textContent = detail;
  }
  function sizeLabel(size) {
    if (size < 1024) return size + " B";
    if (size < 1048576) return (size / 1024).toFixed(1) + " KB";
    return (size / 1048576).toFixed(2) + " MB";
  }
  function cleanName(name) {
    return (name || "document.pdf").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 90) || "document";
  }
  function visiblePages() {
    if (!pdfDocument) return [];
    const pages = [];
    for (let n = 1; n <= pdfDocument.numPages; n++) if (!removed.has(n)) pages.push(n);
    return pages;
  }
  function pageEdits() {
    if (!edits[currentPage]) edits[currentPage] = [];
    return edits[currentPage];
  }
  function pointToPdf(point) {
    const result = viewport.convertToPdfPoint(point.x, point.y);
    return { x: result[0], y: result[1] };
  }
  function screenRectToPdf(x, y, w, h) {
    const corners = [
      pointToPdf({x, y}), pointToPdf({x: x + w, y}),
      pointToPdf({x, y: y + h}), pointToPdf({x: x + w, y: y + h})
    ];
    const xs = corners.map(p => p.x), ys = corners.map(p => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  function pdfToScreen(point) {
    const p = viewport.convertToViewportPoint(point.x, point.y);
    return { x: p[0], y: p[1] };
  }
  function pdfRectToScreen(rect) {
    const pts = [
      pdfToScreen({x: rect.x, y: rect.y}), pdfToScreen({x: rect.x + rect.w, y: rect.y}),
      pdfToScreen({x: rect.x, y: rect.y + rect.h}), pdfToScreen({x: rect.x + rect.w, y: rect.y + rect.h})
    ];
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    return {x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys)};
  }
  function currentPoint(event) {
    const rect = noteCanvas.getBoundingClientRect();
    return {x: (event.clientX - rect.left) * noteCanvas.width / rect.width, y: (event.clientY - rect.top) * noteCanvas.height / rect.height};
  }
  function drawStroke(ctx, points, color, width) {
    if (!points || !points.length) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i=1;i<points.length;i++) ctx.lineTo(points[i].x, points[i].y);
    if (points.length===1) ctx.lineTo(points[0].x + .1, points[0].y + .1);
    ctx.strokeStyle = color || "#20243a";
    ctx.lineWidth = width || 2.5;
    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke();
    ctx.restore();
  }
  function drawOp(ctx, op) {
    ctx.save();
    if (op.type === "text") {
      const p = pdfToScreen({x: op.x, y: op.y});
      const fs = Math.max(4, (op.fontSize || 12) * viewport.scale);
      ctx.fillStyle = op.color || "#20243a";
      ctx.font = fs + "px Arial, sans-serif"; ctx.textBaseline = "alphabetic";
      String(op.text || "").split("\n").forEach((line, i) => ctx.fillText(line, p.x, p.y + fs * .8 + i * fs * 1.2));
    } else if (op.type === "cover" || op.type === "highlight" || op.type === "image") {
      const r = pdfRectToScreen(op);
      if (op.type === "cover") {
        ctx.fillStyle = "#fff"; ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = "#d8deea"; ctx.lineWidth = .7; ctx.strokeRect(r.x, r.y, r.w, r.h);
      } else if (op.type === "highlight") {
        ctx.globalAlpha = .34; ctx.fillStyle = op.color || "#ffe66b"; ctx.fillRect(r.x, r.y, r.w, r.h);
      } else if (op.dataUrl) {
        const image = new Image();
        image.onload = () => { if (pdfDocument) ctx.drawImage(image, r.x, r.y, r.w, r.h); };
        image.src = op.dataUrl;
      }
    } else if (op.type === "path") {
      drawStroke(ctx, (op.points || []).map(pdfToScreen), op.color, Math.max(.6, (op.width || 2) * viewport.scale));
    }
    ctx.restore();
  }
  function redraw(temp = null) {
    if (!viewport) return;
    noteCtx.clearRect(0, 0, noteCanvas.width, noteCanvas.height);
    (edits[currentPage] || []).forEach(op => drawOp(noteCtx, op));
    if (!temp) return;
    if (temp.type === "draw" || temp.type === "signature") drawStroke(noteCtx, temp.points, temp.color, temp.width);
    if ((temp.type === "highlight" || temp.type === "replace") && temp.points.length > 1) {
      const a=temp.points[0], b=temp.points[temp.points.length-1];
      const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y),w=Math.abs(b.x-a.x),h=Math.abs(b.y-a.y);
      noteCtx.save(); noteCtx.fillStyle=temp.type==="highlight"?"rgba(255,230,107,.34)":"rgba(97,87,232,.13)";
      noteCtx.strokeStyle=temp.type==="highlight"?"#d8bd34":"#756cf0"; noteCtx.setLineDash([5,4]);
      noteCtx.fillRect(x,y,w,h); noteCtx.strokeRect(x,y,w,h); noteCtx.restore();
    }
  }
  function refreshPageInfo() {
    if (!pdfDocument) return;
    const pages=visiblePages(), index=pages.indexOf(currentPage);
    $("pageNumber").max=String(pdfDocument.numPages); $("pageNumber").value=String(currentPage);
    $("pageCount").textContent=String(pdfDocument.numPages);
    $("sidePageCount").textContent=pdfDocument.numPages + (pdfDocument.numPages===1?" page":" pages");
    $("sideCurrentPage").textContent=removed.has(currentPage)?"Marked for removal":String(currentPage);
    $("prevPageButton").disabled=index<=0; $("nextPageButton").disabled=index<0||index>=pages.length-1;
    $("deletePageButton").disabled=pages.length<=1; $("downloadButton").disabled=false;
    $("zoomInButton").disabled=false; $("zoomOutButton").disabled=false; $("rotateButton").disabled=false; $("extractButton").disabled=false;
    $("zoomLabel").textContent=Math.round(zoom*100)+"%";
    $("editCount").textContent=String(Object.values(edits).reduce((sum,list)=>sum+list.length,0));
    $("undoButton").disabled=undoStack.length===0; $("redoButton").disabled=redoStack.length===0;
  }
  function setTool(tool) {
    activeTool=tool;
    document.querySelectorAll("[data-tool]").forEach(b=>b.classList.toggle("active",b.dataset.tool===tool));
    $("toolHint").textContent=hints[tool]||"Choose a tool.";
    noteCanvas.style.cursor=tool==="select"?"default":tool==="text"||tool==="image"?"copy":"crosshair";
  }
  function historyPoint() {
    undoStack.push(JSON.stringify(edits));
    if (undoStack.length>35) undoStack.shift();
    redoStack=[];
    $("undoButton").disabled=false; $("redoButton").disabled=true;
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(edits)); edits=JSON.parse(undoStack.pop());
    redraw(); refreshPageInfo(); scheduleAutosave(); toast("Last edit undone.");
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(edits)); edits=JSON.parse(redoStack.pop());
    redraw(); refreshPageInfo(); scheduleAutosave(); toast("Edit restored.");
  }
  function downloadFile(bytes, filename, mime="application/pdf") {
    if (window.EditoraNative && typeof window.EditoraNative.saveBase64File==="function") {
      try {
        const array=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
        let binary="";
        const chunk=0x8000;
        for (let i=0;i<array.length;i+=chunk) binary+=String.fromCharCode(...array.subarray(i,Math.min(i+chunk,array.length)));
        window.EditoraNative.saveBase64File(filename,mime,btoa(binary));
        toast("Saving to the Android Downloads folder…");
        return;
      } catch (error) { console.error("Native save failed",error); }
    }
    const blob=new Blob([bytes],{type:mime}),url=URL.createObjectURL(blob),a=document.createElement("a");
    a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1800);
  }
  async function renderPage() {
    if (!pdfDocument) return;
    const available=visiblePages();
    if (!available.length) return toast("At least one page needs to remain.");
    if (!available.includes(currentPage)) currentPage=available[0];
    setBusy(true,"Rendering page…","Preparing your PDF preview.");
    try {
      const page=await pdfDocument.getPage(currentPage);
      const rotation=((page.rotate||0)+(rotations[currentPage]||0))%360;
      const base=page.getViewport({scale:1,rotation});
      const fit=Math.min(1.25,Math.max(.25,(viewportHost.clientWidth-34)/base.width));
      const scale=Math.max(.25,Math.min(3,fit*zoom));
      viewport=page.getViewport({scale,rotation});
      pdfCanvas.width=Math.ceil(viewport.width);pdfCanvas.height=Math.ceil(viewport.height);
      noteCanvas.width=pdfCanvas.width;noteCanvas.height=pdfCanvas.height;
      pdfCanvas.style.width=viewport.width+"px";pdfCanvas.style.height=viewport.height+"px";
      noteCanvas.style.width=viewport.width+"px";noteCanvas.style.height=viewport.height+"px";
      stack.style.width=viewport.width+"px";stack.style.height=viewport.height+"px";
      const ctx=pdfCanvas.getContext("2d",{alpha:false});
      ctx.fillStyle="#fff";ctx.fillRect(0,0,pdfCanvas.width,pdfCanvas.height);
      await page.render({canvasContext:ctx,viewport}).promise;
      redraw();refreshPageInfo();status("Page "+currentPage+" of "+pdfDocument.numPages);
    } catch(error) { console.error(error);toast("This page could not be rendered."); }
    finally {setBusy(false);}
  }
  async function openFile(file) {
    if (!file) return;
    if (!(file.type==="application/pdf"||file.name.toLowerCase().endsWith(".pdf"))) return toast("Please choose a PDF file.");
    if (!window.pdfjsLib||!window.PDFLib) return toast("PDF libraries are not ready. Check your internet and reload.",5000);
    setBusy(true,"Opening PDF…","Reading the file locally in your browser.");
    try {
      const bytes=new Uint8Array(await file.arrayBuffer());
      const parsed=await pdfjsLib.getDocument({data:bytes.slice()}).promise;
      pdfDocument=parsed;sourceBytes=bytes;sourceName=file.name||"document.pdf";
      currentPage=1;zoom=1;removed=new Set();rotations={};edits={};undoStack=[];redoStack=[];
      $("welcome").classList.add("hidden");$("editorView").classList.remove("hidden");
      $("documentName").textContent=sourceName;$("documentMeta").textContent=sizeLabel(bytes.byteLength)+" · PDF document";
      $("sideFileName").textContent=sourceName;$("sideFileSize").textContent=sizeLabel(bytes.byteLength);
      refreshPageInfo();await renderPage();scheduleAutosave();toast("PDF opened. Choose a tool to start editing.");
    } catch(error) {console.error(error);toast("Could not open this PDF. It may be damaged or password-protected.");}
    finally {setBusy(false);}
  }
  async function buildPdf() {
    if (!sourceBytes) throw new Error("Open a PDF first.");
    const {PDFDocument,StandardFonts,rgb,degrees}=PDFLib;
    const out=await PDFDocument.load(sourceBytes.slice());
    const font=await out.embedFont(StandardFonts.Helvetica);
    const all=out.getPages();
    for (let i=0;i<all.length;i++) {
      const no=i+1;if(removed.has(no))continue;
      const page=all[i],rotation=rotations[no]||0;
      if(rotation) page.setRotation(degrees(((page.getRotation().angle||0)+rotation)%360));
      for (const op of edits[no]||[]) {
        if(op.type==="text") {
          const fontSize=Math.max(4,op.fontSize||12),hex=(op.color||"#20243a").replace("#","");
          const color=rgb(parseInt(hex.slice(0,2),16)/255,parseInt(hex.slice(2,4),16)/255,parseInt(hex.slice(4,6),16)/255);
          String(op.text||"").split("\n").forEach((line,index)=>page.drawText(line,{x:op.x,y:op.y-fontSize-index*fontSize*.25,size:fontSize,font,color,maxWidth:Math.max(30,page.getWidth())}));
        } else if(op.type==="cover"||op.type==="highlight") {
          const c=op.type==="cover"?rgb(1,1,1):rgb(1,.9,.2);
          page.drawRectangle({x:op.x,y:op.y,width:Math.max(1,op.w),height:Math.max(1,op.h),color:c,opacity:op.type==="cover"?1:.32,borderWidth:0});
        } else if(op.type==="path"&&op.points&&op.points.length) {
          const hex=(op.color||"#20243a").replace("#","");
          const color=rgb(parseInt(hex.slice(0,2),16)/255,parseInt(hex.slice(2,4),16)/255,parseInt(hex.slice(4,6),16)/255);
          for(let j=1;j<op.points.length;j++) page.drawLine({start:op.points[j-1],end:op.points[j],thickness:Math.max(.5,op.width||1.5),color});
        } else if(op.type==="image"&&op.dataUrl) {
          const raw=Uint8Array.from(atob(op.dataUrl.split(",")[1]),c=>c.charCodeAt(0));
          const image=op.dataUrl.startsWith("data:image/png")?await out.embedPng(raw):await out.embedJpg(raw);
          page.drawImage(image,{x:op.x,y:op.y,width:Math.max(1,op.w),height:Math.max(1,op.h)});
        }
      }
    }
    for(let i=all.length-1;i>=0;i--) if(removed.has(i+1)) out.removePage(i);
    return await out.save();
  }
  async function exportPdf() {
    if(!pdfDocument)return toast("Open a PDF first.");
    setBusy(true,"Applying edits…","Preparing a new copy; your original stays unchanged.");
    try {const bytes=await buildPdf();downloadFile(bytes,cleanName(sourceName)+"-edited.pdf");status("Edited PDF exported");toast("Edited PDF saved as a new copy.");}
    catch(error){console.error(error);toast("Export failed. This PDF may be protected or unsupported.");}
    finally{setBusy(false);}
  }
  async function extractPage() {
    if(!pdfDocument)return toast("Open a PDF first.");
    const index=visiblePages().indexOf(currentPage);if(index<0)return toast("This page is marked for removal.");
    setBusy(true,"Extracting page…","Applying edits to the selected page.");
    try {const edited=await buildPdf(),src=await PDFLib.PDFDocument.load(edited),out=await PDFLib.PDFDocument.create(),[p]=await out.copyPages(src,[index]);out.addPage(p);downloadFile(await out.save(),cleanName(sourceName)+"-page-"+currentPage+".pdf");toast("Page downloaded as a separate PDF.");}
    catch(error){console.error(error);toast("Could not extract this page.");}finally{setBusy(false);}
  }
  async function mergeFiles(files) {
    const picked=Array.from(files||[]);if(picked.length<2)return toast("Choose at least two PDFs to merge.");
    setBusy(true,"Merging PDFs…","Combining selected documents in your browser.");
    try {
      const out=await PDFLib.PDFDocument.create();
      for(const file of picked){const src=await PDFLib.PDFDocument.load(await file.arrayBuffer());const pages=await out.copyPages(src,src.getPageIndices());pages.forEach(p=>out.addPage(p));}
      const bytes=await out.save(),file=new File([bytes],"merged-documents.pdf",{type:"application/pdf"});
      await openFile(file);toast("PDFs merged. Review the file and download the combined copy.");
    }catch(error){console.error(error);toast("Merge failed. One PDF may be damaged or password-protected.");}
    finally{setBusy(false);mergeInput.value="";}
  }
  function addText(screen) {
    const text=prompt("Enter the text to add:");if(text===null||text==="")return;
    const size=Number(prompt("Text size in PDF points (8–36):","12"));if(!Number.isFinite(size)&&size!==0)return;
    const p=pointToPdf(screen);historyPoint();
    pageEdits().push({type:"text",x:p.x,y:p.y,text,fontSize:Math.max(8,Math.min(36,size||12)),color:"#20243a"});
    redraw();refreshPageInfo();scheduleAutosave();toast("Text added. Download to apply it to your PDF.");
  }
  function chooseImage(screen) {imagePoint=screen;imageInput.click();}
  imageInput.addEventListener("change",async()=>{
    const file=imageInput.files&&imageInput.files[0];if(!file||!imagePoint){imageInput.value="";return;}
    if(!["image/png","image/jpeg"].includes(file.type)){toast("Choose a PNG or JPG image.");imageInput.value="";return;}
    try {
      const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
      const img=new Image();
      img.onload=()=>{
        const width=Math.min(180,Math.max(70,150)),height=width*img.naturalHeight/img.naturalWidth;
        const r=screenRectToPdf(imagePoint.x,imagePoint.y,width,height);historyPoint();
        pageEdits().push({type:"image",x:r.x,y:r.y,w:r.w,h:r.h,dataUrl});
        redraw();refreshPageInfo();scheduleAutosave();toast("Image inserted. Download to embed it in the PDF.");imagePoint=null;imageInput.value="";
      };
      img.onerror=()=>{toast("Could not read this image.");imageInput.value="";};img.src=dataUrl;
    }catch(error){console.error(error);toast("Could not load the image.");imageInput.value="";}
  });
  noteCanvas.addEventListener("click",event=>{
    if(!pdfDocument||busy||gesture)return;
    const p=currentPoint(event);
    if(activeTool==="text") addText(p);
    if(activeTool==="image") chooseImage(p);
  });
  noteCanvas.addEventListener("pointerdown",event=>{
    if(!pdfDocument||busy||["select","text","image"].includes(activeTool))return;
    event.preventDefault();noteCanvas.setPointerCapture(event.pointerId);
    gesture={type:activeTool,points:[currentPoint(event)],color:activeTool==="highlight"?"#ffe66b":activeTool==="signature"?"#18244a":"#20243a",width:activeTool==="signature"?2.8:2.2};
  });
  noteCanvas.addEventListener("pointermove",event=>{
    if(!gesture)return;gesture.points.push(currentPoint(event));redraw(gesture);
  });
  function finishGesture() {
    if(!gesture)return;
    const done=gesture;gesture=null;
    if(done.type==="draw"||done.type==="signature") {
      if(done.points.length<2){redraw();return;}
      historyPoint();
      pageEdits().push({type:"path",points:done.points.map(pointToPdf),color:done.color,width:done.width/(viewport.scale||1)});
      redraw();refreshPageInfo();scheduleAutosave();toast(done.type==="signature"?"Signature stroke added.":"Drawing added.");return;
    }
    if(done.points.length<2){redraw();return;}
    const a=done.points[0],b=done.points[done.points.length-1],x=Math.min(a.x,b.x),y=Math.min(a.y,b.y),w=Math.abs(b.x-a.x),h=Math.abs(b.y-a.y);
    if(w<3||h<3){redraw();return;}
    const rect=screenRectToPdf(x,y,w,h);
    if(done.type==="highlight") {
      historyPoint();pageEdits().push({type:"highlight",...rect,color:"#ffe66b"});redraw();refreshPageInfo();scheduleAutosave();toast("Highlight added.");
    } else if(done.type==="replace") {
      const text=prompt("Enter replacement text. The selected area will be visually covered.");if(text===null){redraw();return;}
      const size=Number(prompt("Replacement text size (8–24):","11"))||11,p=pointToPdf({x:x+3,y:y+3});
      historyPoint();
      pageEdits().push({type:"cover",...rect});
      pageEdits().push({type:"text",x:p.x,y:p.y,text,fontSize:Math.max(8,Math.min(24,size)),color:"#20243a"});
      redraw();refreshPageInfo();scheduleAutosave();toast("Area covered and replacement added. This is visual replacement, not source-text redaction.");
    }
  }
  noteCanvas.addEventListener("pointerup",finishGesture);
  noteCanvas.addEventListener("pointercancel",finishGesture);

  function pageStep(delta) {
    const pages=visiblePages(),index=pages.indexOf(currentPage),next=pages[index+delta];
    if(next){currentPage=next;renderPage();}
  }
  $("openButton").addEventListener("click",()=>fileInput.click());
  $("welcomeOpenButton").addEventListener("click",()=>fileInput.click());
  $("sideOpenButton").addEventListener("click",()=>fileInput.click());
  $("mobileOpenButton").addEventListener("click",()=>fileInput.click());
  fileInput.addEventListener("change",async()=>{await openFile(fileInput.files&&fileInput.files[0]);fileInput.value="";});
  $("downloadButton").addEventListener("click",exportPdf);$("sideSaveButton").addEventListener("click",exportPdf);
  $("extractButton").addEventListener("click",extractPage);
  $("mergeButton").addEventListener("click",()=>mergeInput.click());$("sideMergeButton").addEventListener("click",()=>mergeInput.click());
  mergeInput.addEventListener("change",()=>mergeFiles(mergeInput.files));
  $("prevPageButton").addEventListener("click",()=>pageStep(-1));$("nextPageButton").addEventListener("click",()=>pageStep(1));
  $("pageNumber").addEventListener("change",()=>{if(!pdfDocument)return;const want=Math.max(1,Math.min(pdfDocument.numPages,Number($("pageNumber").value)||1)),pages=visiblePages();currentPage=pages.includes(want)?want:(pages.find(n=>n>=want)||pages[pages.length-1]);renderPage();});
  $("zoomInButton").addEventListener("click",()=>{zoom=Math.min(2.6,zoom+.15);scheduleAutosave();renderPage();});
  $("zoomOutButton").addEventListener("click",()=>{zoom=Math.max(.5,zoom-.15);scheduleAutosave();renderPage();});

  // Custom two-finger pinch zoom for touch devices.
  let pinchStartDistance = 0, pinchStartZoom = 1, pinchActive = false, pinchRenderQueued = false;
  function touchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }
  viewportHost.addEventListener("touchstart", event => {
    if (!pdfDocument || event.touches.length !== 2) return;
    pinchActive = true;
    pinchStartDistance = touchDistance(event.touches);
    pinchStartZoom = zoom;
  }, {passive:true});
  viewportHost.addEventListener("touchmove", event => {
    if (!pinchActive || event.touches.length !== 2 || !pinchStartDistance) return;
    event.preventDefault();
    const ratio = touchDistance(event.touches) / pinchStartDistance;
    zoom = Math.max(.5, Math.min(2.6, pinchStartZoom * ratio));
    scheduleAutosave();
    $("zoomLabel").textContent = Math.round(zoom * 100) + "%";
    if (!pinchRenderQueued) {
      pinchRenderQueued = true;
      requestAnimationFrame(() => {
        pinchRenderQueued = false;
        if (pinchActive && pdfDocument) renderPage();
      });
    }
  }, {passive:false});
  function finishPinch(event) {
    if (event.touches.length < 2) {
      pinchActive = false;
      pinchStartDistance = 0;
    }
  }
  viewportHost.addEventListener("touchend", finishPinch, {passive:true});
  viewportHost.addEventListener("touchcancel", finishPinch, {passive:true});
  $("rotateButton").addEventListener("click",()=>{if(!pdfDocument)return;rotations[currentPage]=((rotations[currentPage]||0)+90)%360;scheduleAutosave();renderPage();toast("Page rotated. Download to save the change.");});
  $("deletePageButton").addEventListener("click",()=>{if(!pdfDocument)return;if(visiblePages().length<=1)return toast("At least one page must remain.");if(!confirm("Mark page "+currentPage+" for removal from the exported PDF?"))return;removed.add(currentPage);currentPage=visiblePages().find(n=>n>currentPage)||visiblePages().slice(-1)[0];scheduleAutosave();refreshPageInfo();renderPage();toast("Page marked for removal; download to apply it.");});
  $("undoButton").addEventListener("click",undo);$("redoButton").addEventListener("click",redo);
  document.querySelectorAll("[data-tool]").forEach(button=>button.addEventListener("click",()=>setTool(button.dataset.tool)));
  const drop=$("dropZone");
  ["dragenter","dragover"].forEach(type=>drop.addEventListener(type,event=>{event.preventDefault();drop.classList.add("drag-over");}));
  ["dragleave","drop"].forEach(type=>drop.addEventListener(type,event=>{event.preventDefault();drop.classList.remove("drag-over");}));
  drop.addEventListener("drop",event=>{const f=Array.from(event.dataTransfer.files||[]).find(file=>file.type==="application/pdf"||file.name.toLowerCase().endsWith(".pdf"));if(f)openFile(f);else toast("Drop a PDF file to open it.");});
  window.addEventListener("beforeinstallprompt",event=>{event.preventDefault();installPrompt=event;$("installButton").classList.remove("hidden");});
  $("installButton").addEventListener("click",async()=>{if(!installPrompt)return toast("Open your browser menu and choose Install app / Add to Home screen.");installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$("installButton").classList.add("hidden");});
  window.addEventListener("resize",()=>{if(pdfDocument)renderPage();});
  if(!window.pdfjsLib||!window.PDFLib)window.addEventListener("load",()=>setTimeout(()=>{if(!window.pdfjsLib||!window.PDFLib)toast("PDF libraries didn't load. Check your internet and reload.",6000);},1000));
  setTool("select");
  window.addEventListener("load", () => { if (window.pdfjsLib && window.PDFLib) restoreLocalWorkspace(); });
})();