(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const fileInput = $("fileInput");
  const mergeInput = $("mergeInput");
  const imageInput = $("imageInput");
  const pdfCanvas = $("pdfCanvas");
  const annotationCanvas = $("annotationCanvas");
  const annotationCtx = annotationCanvas.getContext("2d");
  const pageStack = $("pageStack");
  const pageViewport = $("pageViewport");
  const toast = $("toast");

  let pdfDocument = null;
  let originalBytes = null;
  let originalFileName = "document.pdf";
  let activeTool = "select";
  let currentPage = 1;
  let zoomFactor = 1;
  let lastViewport = null;
  let pageRotations = {};
  let deletedPages = new Set();
  let pageEdits = {};
  let undoStack = [];
  let redoStack = [];
  let gesture = null;
  let imagePlacement = null;
  let toastTimer = null;
  let busy = false;
  let installPrompt = null;
  let lastRenderedPage = 0;

  const toolHints = {
    select: "Navigate the page. Choose a tool to edit.",
    text: "Tap or click where the text should start.",
    replace: "Drag over the area to cover, then enter replacement text.",
    highlight: "Drag over a line or paragraph to highlight it.",
    draw: "Press and drag to draw freehand.",
    image: "Tap or click to place an image after selecting it.",
    signature: "Draw your signature with a mouse or finger."
  };

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  function showToast(message, duration = 3200) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), duration);
  }

  function setStatus(message) {
    $("statusText").textContent = message;
    $("pageState").textContent = message;
  }

  function setBusy(on, title = "Working on your PDF…", detail = "Please keep this tab open.") {
    busy = on;
    $("busyLayer").classList.toggle("hidden", !on);
    $("busyTitle").textContent = title;
    $("busyDetail").textContent = detail;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  function safeName(name) {
    return (name || "document").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 90) || "document";
  }

  function downloadBytes(bytes, filename, mime = "application/pdf") {
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function visiblePages() {
    if (!pdfDocument) return [];
    const pages = [];
    for (let n = 1; n <= pdfDocument.numPages; n++) if (!deletedPages.has(n)) pages.push(n);
    return pages;
  }

  function editsFor(pageNo) {
    if (!pageEdits[pageNo]) pageEdits[pageNo] = [];
    return pageEdits[pageNo];
  }

  function snapshotEdits() {
    return JSON.stringify(pageEdits);
  }

  function addHistoryPoint() {
    undoStack.push(snapshotEdits());
    if (undoStack.length > 40) undoStack.shift();
    redoStack = [];
    updateUndoButtons();
  }

  function updateUndoButtons() {
    $("undoButton").disabled = undoStack.length === 0;
    $("redoButton").disabled = redoStack.length === 0;
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshotEdits());
    pageEdits = JSON.parse(undoStack.pop());
    updateUndoButtons();
    redrawAnnotations();
    updateEditCount();
    showToast("Last annotation undone.");
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshotEdits());
    pageEdits = JSON.parse(redoStack.pop());
    updateUndoButtons();
    redrawAnnotations();
    updateEditCount();
    showToast("Annotation restored.");
  }

  function updateEditCount() {
    const count = Object.values(pageEdits).reduce((sum, edits) => sum + edits.length, 0);
    $("editCount").textContent = String(count);
  }

  function updatePageUI() {
    if (!pdfDocument) return;
    const pages = visiblePages();
    $("pageNumber").max = String(pdfDocument.numPages);
    $("pageNumber").value = String(currentPage);
    $("pageCount").textContent = String(pdfDocument.numPages);
    $("sidePageCount").textContent = pdfDocument.numPages + (pdfDocument.numPages === 1 ? " page" : " pages");
    $("sideCurrentPage").textContent = deletedPages.has(currentPage) ? "Marked for removal" : String(currentPage);
    $("prevPageButton").disabled = pages.length < 2 || pages.indexOf(currentPage) <= 0;
    $("nextPageButton").disabled = pages.length < 2 || pages.indexOf(currentPage) < 0 || pages.indexOf(currentPage) >= pages.length - 1;
    $("deletePageButton").disabled = pages.length <= 1;
    $("rotateButton").disabled = false;
    $("extractButton").disabled = false;
    $("zoomInButton").disabled = false;
    $("zoomOutButton").disabled = false;
    $("downloadButton").disabled = false;
    $("zoomLabel").textContent = Math.round(zoomFactor * 100) + "%";
    updateEditCount();
  }

  function setTool(tool) {
    activeTool = tool;
    document.querySelectorAll("[data-tool]").forEach(button => {
      button.classList.toggle("active", button.dataset.tool === tool);
    });
    $("toolHint").textContent = toolHints[tool] || "Choose a tool.";
    annotationCanvas.style.cursor = tool === "select" ? "default" : tool === "text" || tool === "image" ? "copy" : "crosshair";
  }

  function pointerPosition(event) {
    const rect = annotationCanvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(annotationCanvas.width, (event.clientX - rect.left) * annotationCanvas.width / rect.width)),
      y: Math.max(0, Math.min(annotationCanvas.height, (event.clientY - rect.top) * annotationCanvas.height / rect.height))
    };
  }

  function drawPath(ctx, points, color, width) {
    if (!points || !points.length) return;
    ctx.save();
    ctx.strokeStyle = color || "#20284a";
    ctx.lineWidth = width || 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    if (points.length === 1) ctx.lineTo(points[0].x + 0.1, points[0].y + 0.1);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
    ctx.restore();
  }

  function viewportMetadata() {
    if (!lastViewport) return { viewTransform: [1, 0, 0, -1, 0, 0], viewInverse: [1, 0, 0, -1, 0, 0], viewScale: 1 };
    const t = lastViewport.transform;
    const det = t[0] * t[3] - t[1] * t[2];
    const inverse = [
      t[3] / det, -t[1] / det, -t[2] / det, t[0] / det,
      (t[2] * t[5] - t[3] * t[4]) / det,
      (t[1] * t[4] - t[0] * t[5]) / det
    ];
    return { viewTransform: Array.from(t), viewInverse: inverse, viewScale: lastViewport.scale };
  }

  function pointThroughMatrix(point, matrix) {
    return {
      x: matrix[0] * point.x + matrix[2] * point.y + matrix[4],
      y: matrix[1] * point.x + matrix[3] * point.y + matrix[5]
    };
  }

  function opPointToPdf(op, point) {
    return pointThroughMatrix(point, op.viewInverse || [1, 0, 0, -1, 0, 0]);
  }

  function opPointToCurrentCanvas(op, point) {
    if (!lastViewport) return point;
    const pdfPoint = opPointToPdf(op, point);
    const currentPoint = lastViewport.convertToViewportPoint(pdfPoint.x, pdfPoint.y);
    return { x: currentPoint[0], y: currentPoint[1] };
  }

  function opRectToPdf(op, x, y, w, h) {
    const pts = [
      opPointToPdf(op, { x, y }),
      opPointToPdf(op, { x: x + w, y }),
      opPointToPdf(op, { x, y: y + h }),
      opPointToPdf(op, { x: x + w, y: y + h })
    ];
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }

  function opRectToCurrentCanvas(op, x, y, w, h) {
    const pdfRect = opRectToPdf(op, x, y, w, h);
    const points = [
      lastViewport.convertToViewportPoint(pdfRect.x, pdfRect.y),
      lastViewport.convertToViewportPoint(pdfRect.x + pdfRect.w, pdfRect.y),
      lastViewport.convertToViewportPoint(pdfRect.x, pdfRect.y + pdfRect.h),
      lastViewport.convertToViewportPoint(pdfRect.x + pdfRect.w, pdfRect.y + pdfRect.h)
    ];
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }

  function drawOperation(ctx, op) {
    ctx.save();
    if (op.type === "text") {
      const point = opPointToCurrentCanvas(op, { x: op.x, y: op.y });
      const size = Math.max(4, (op.fontSize || 16) / (op.viewScale || 1) * lastViewport.scale);
      ctx.fillStyle = op.color || "#20243a";
      ctx.font = size + "px Arial, sans-serif";
      ctx.textBaseline = "top";
      const lines = String(op.text || "").split("\n");
      lines.forEach((line, i) => ctx.fillText(line, point.x, point.y + i * size * 1.25));
    } else if (op.type === "cover" || op.type === "highlight" || op.type === "image") {
      const rect = opRectToCurrentCanvas(op, op.x, op.y, op.w, op.h);
      if (op.type === "cover") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.strokeStyle = "#d8deea";
        ctx.lineWidth = 0.7;
        ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      } else if (op.type === "highlight") {
        ctx.globalAlpha = 0.34;
        ctx.fillStyle = op.color || "#ffe66b";
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      } else if (op.dataUrl) {
        const image = new Image();
        image.onload = () => {
          if (lastRenderedPage === currentPage) ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h);
        };
        image.src = op.dataUrl;
      }
    } else if (op.type === "path") {
      const points = (op.points || []).map(point => opPointToCurrentCanvas(op, point));
      const width = (op.width || 2.5) / (op.viewScale || 1) * lastViewport.scale;
      drawPath(ctx, points, op.color, width);
    }
    ctx.restore();
  }

  function redrawAnnotations(extraGesture = null) {
    if (!lastViewport) return;
    annotationCtx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
    for (const op of editsFor(currentPage)) drawOperation(annotationCtx, op);
    if (extraGesture) {
      if (extraGesture.type === "highlight" || extraGesture.type === "replace") {
        const p = extraGesture.points;
        if (p.length > 1) {
          annotationCtx.save();
          annotationCtx.fillStyle = extraGesture.type === "highlight" ? "rgba(255,230,107,.34)" : "rgba(97,87,232,.13)";
          annotationCtx.strokeStyle = extraGesture.type === "highlight" ? "#e0c444" : "#756cf0";
          annotationCtx.setLineDash([5, 4]);
          const x = Math.min(p[0].x, p[p.length - 1].x), y = Math.min(p[0].y, p[p.length - 1].y);
          annotationCtx.fillRect(x, y, Math.abs(p[p.length - 1].x - p[0].x), Math.abs(p[p.length - 1].y - p[0].y));
          annotationCtx.strokeRect(x, y, Math.abs(p[p.length - 1].x - p[0].x), Math.abs(p[p.length - 1].y - p[0].y));
          annotationCtx.restore();
        }
      } else if (extraGesture.type === "draw" || extraGesture.type === "signature") {
        drawPath(annotationCtx, extraGesture.points, extraGesture.color, extraGesture.width);
      }
    }
  }

  async function renderCurrentPage() {
    if (!pdfDocument) return;
    const available = visiblePages();
    if (!available.length) return;
    if (deletedPages.has(currentPage) || currentPage < 1 || currentPage > pdfDocument.numPages) currentPage = available[0];
    setBusy(true, "Rendering page…", "Preparing the document preview.");
    try {
      const pdfPage = await pdfDocument.getPage(currentPage);
      const rotation = ((pdfPage.rotate || 0) + (pageRotations[currentPage] || 0)) % 360;
      const baseViewport = pdfPage.getViewport({ scale: 1, rotation });
      const maxWidth = Math.max(260, pageViewport.clientWidth - 32);
      const fitScale = Math.min(1.25, maxWidth / baseViewport.width);
      const scale = Math.max(0.25, Math.min(3, fitScale * zoomFactor));
      const viewport = pdfPage.getViewport({ scale, rotation });
      lastViewport = viewport;
      lastRenderedPage = currentPage;
      pdfCanvas.width = Math.ceil(viewport.width);
      pdfCanvas.height = Math.ceil(viewport.height);
      annotationCanvas.width = Math.ceil(viewport.width);
      annotationCanvas.height = Math.ceil(viewport.height);
      pdfCanvas.style.width = viewport.width + "px";
      pdfCanvas.style.height = viewport.height + "px";
      annotationCanvas.style.width = viewport.width + "px";
      annotationCanvas.style.height = viewport.height + "px";
      pageStack.style.width = viewport.width + "px";
      pageStack.style.height = viewport.height + "px";
      const context = pdfCanvas.getContext("2d", { alpha: false });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, pdfCanvas.width, pdfCanvas.height);
      await pdfPage.render({ canvasContext: context, viewport }).promise;
      redrawAnnotations();
      updatePageUI();
      $("pageState").textContent = "Page " + currentPage + " ready";
      setStatus("Page " + currentPage + " of " + pdfDocument.numPages);
    } catch (error) {
      console.error(error);
      showToast("This page could not be rendered. Try opening the PDF again.");
    } finally {
      setBusy(false);
    }
  }

  async function openPdfFile(file) {
    if (!file) return;
    if (!(file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))) {
      showToast("Please choose a PDF file.");
      return;
    }
    if (!window.pdfjsLib || !window.PDFLib) {
      showToast("PDF engine could not load. Check your internet connection and reload.");
      return;
    }
    setBusy(true, "Opening PDF…", "Reading the file locally in this browser.");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const loadingTask = pdfjsLib.getDocument({ data: bytes.slice() });
      const loadedDocument = await loadingTask.promise;
      pdfDocument = loadedDocument;
      originalBytes = bytes;
      originalFileName = file.name || "document.pdf";
      pageRotations = {};
      deletedPages = new Set();
      pageEdits = {};
      undoStack = [];
      redoStack = [];
      currentPage = 1;
      zoomFactor = 1;
      $("welcome").classList.add("hidden");
      $("editorView").classList.remove("hidden");
      $("documentName").textContent = originalFileName;
      $("documentMeta").textContent = formatBytes(bytes.byteLength) + " · PDF document";
      $("sideFileName").textContent = originalFileName;
      $("sideFileSize").textContent = formatBytes(bytes.byteLength);
      updateUndoButtons();
      updatePageUI();
      setStatus("PDF loaded locally");
      await renderCurrentPage();
      showToast("PDF opened. Choose a tool to start editing.");
    } catch (error) {
      console.error(error);
      showToast("Could not open this PDF. It may be damaged or password-protected.");
    } finally {
      setBusy(false);
    }
  }

  function mapRectToPdf(op, x, y, w, h) {
    return opRectToPdf(op, x, y, w, h);
  }

  async function buildEditedPdf() {
    if (!originalBytes || !window.PDFLib) throw new Error("No PDF is open.");
    const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
    const document = await PDFDocument.load(originalBytes.slice(), { ignoreEncryption: false });
    const font = await document.embedFont(StandardFonts.Helvetica);
    const fontBold = await document.embedFont(StandardFonts.HelveticaBold);
    const allPages = document.getPages();

    for (let i = 0; i < allPages.length; i++) {
      const pageNo = i + 1;
      if (deletedPages.has(pageNo)) continue;
      const page = allPages[i];
      const rotationAmount = pageRotations[pageNo] || 0;
      if (rotationAmount) page.setRotation(degrees(((page.getRotation().angle || 0) + rotationAmount) % 360));

      for (const op of editsFor(pageNo)) {
        if (op.type === "text") {
          const point = opPointToPdf(op, { x: op.x, y: op.y });
          const fontSize = Math.max(4, (op.fontSize || 16) / (op.viewScale || 1));
          const colorHex = op.color || "#20243a";
          const color = rgb(parseInt(colorHex.slice(1, 3), 16) / 255, parseInt(colorHex.slice(3, 5), 16) / 255, parseInt(colorHex.slice(5, 7), 16) / 255);
          const lines = String(op.text || "").split("\n");
          lines.forEach((line, lineIndex) => {
            page.drawText(line, { x: point[0], y: point[1] - fontSize - lineIndex * fontSize * .25, size: fontSize, font, color, maxWidth: Math.max(25, 900 / viewport.scale) });
          });
        } else if (op.type === "cover" || op.type === "highlight") {
          const rect = mapRectToPdf(op, op.x, op.y, op.w, op.h);
          const c = op.type === "cover" ? rgb(1, 1, 1) : rgb(1, .9, .2);
          page.drawRectangle({
            x: rect.x, y: rect.y, width: Math.max(1, rect.w), height: Math.max(1, rect.h),
            color: c, opacity: op.type === "cover" ? 1 : .32,
            borderColor: op.type === "cover" ? rgb(1, 1, 1) : c,
            borderWidth: op.type === "cover" ? 0 : .25
          });
        } else if (op.type === "path" && op.points && op.points.length) {
          for (let j = 1; j < op.points.length; j++) {
            const from = opPointToPdf(op, op.points[j - 1]);
            const to = opPointToPdf(op, op.points[j]);
            const hex = op.color || "#242943";
            const color = rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
            page.drawLine({ start: { x: from[0], y: from[1] }, end: { x: to[0], y: to[1] }, thickness: Math.max(1, (op.width || 2.5) / (op.viewScale || 1)), color });
          }
        } else if (op.type === "image" && op.dataUrl) {
          const rect = mapRectToPdf(op, op.x, op.y, op.w, op.h);
          const base64 = op.dataUrl.split(",")[1];
          const imageBytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
          const image = op.dataUrl.startsWith("data:image/png")
            ? await document.embedPng(imageBytes)
            : await document.embedJpg(imageBytes);
          page.drawImage(image, { x: rect.x, y: rect.y, width: Math.max(1, rect.w), height: Math.max(1, rect.h) });
        }
      }
    }

    for (let i = allPages.length - 1; i >= 0; i--) if (deletedPages.has(i + 1)) document.removePage(i);
    return await document.save();
  }

  async function exportPdf() {
    if (!pdfDocument) return showToast("Open a PDF first.");
    setBusy(true, "Applying your changes…", "Preparing a new PDF copy.");
    try {
      const bytes = await buildEditedPdf();
      downloadBytes(bytes, safeName(originalFileName) + "-edited.pdf");
      setStatus("Exported edited PDF");
      showToast("Edited PDF downloaded. Your original file was not overwritten.");
    } catch (error) {
      console.error(error);
      showToast(error && /encrypt|password/i.test(error.message) ? "This PDF is encrypted. Remove its password before editing." : "Could not export this PDF. Try a non-protected PDF.");
    } finally {
      setBusy(false);
    }
  }

  async function extractCurrentPage() {
    if (!pdfDocument) return showToast("Open a PDF first.");
    const pages = visiblePages();
    const visibleIndex = pages.indexOf(currentPage);
    if (visibleIndex < 0) return showToast("This page is marked for deletion.");
    setBusy(true, "Extracting page…", "Applying edits to the selected page.");
    try {
      const editedBytes = await buildEditedPdf();
      const editedDoc = await PDFLib.PDFDocument.load(editedBytes);
      const output = await PDFLib.PDFDocument.create();
      const [page] = await output.copyPages(editedDoc, [visibleIndex]);
      output.addPage(page);
      downloadBytes(await output.save(), safeName(originalFileName) + "-page-" + currentPage + ".pdf");
      showToast("Selected page downloaded as a separate PDF.");
    } catch (error) {
      console.error(error);
      showToast("Could not extract this page.");
    } finally {
      setBusy(false);
    }
  }

  async function mergePdfFiles(files) {
    const chosen = Array.from(files || []);
    if (chosen.length < 2) return showToast("Choose at least two PDF files to merge.");
    if (!window.PDFLib) return showToast("PDF engine is still loading. Reload and try again.");
    setBusy(true, "Merging PDFs…", "Combining files in your browser.");
    try {
      const merged = await PDFLib.PDFDocument.create();
      for (const file of chosen) {
        const bytes = await file.arrayBuffer();
        const source = await PDFLib.PDFDocument.load(bytes);
        const copied = await merged.copyPages(source, source.getPageIndices());
        copied.forEach(page => merged.addPage(page));
      }
      const bytes = await merged.save();
      const blob = new Blob([bytes], { type: "application/pdf" });
      const mergedFile = new File([blob], "merged-documents.pdf", { type: "application/pdf" });
      await openPdfFile(mergedFile);
      showToast("PDF files merged. Review the combined document and download it.");
    } catch (error) {
      console.error(error);
      showToast("Merge failed. One of the PDFs may be password-protected or damaged.");
    } finally {
      setBusy(false);
      mergeInput.value = "";
    }
  }

  function addTextAt(point) {
    const value = window.prompt("Enter text to add:");
    if (value === null || value === "") return;
    const rawSize = window.prompt("Font size in the preview (8–48):", "16");
    if (rawSize === null) return;
    const fontSize = Math.max(8, Math.min(48, Number(rawSize) || 16));
    addHistoryPoint();
    editsFor(currentPage).push({ type: "text", x: point.x, y: point.y, text: value, fontSize, color: "#20243a", ...viewportMetadata() });
    redrawAnnotations();
    updateEditCount();
    showToast("Text added to the page. Download to apply it to the PDF.");
  }

  function placeImageAt(point) {
    imagePlacement = point;
    imageInput.click();
  }

  async function imageInputChanged() {
    const file = imageInput.files && imageInput.files[0];
    if (!file || !imagePlacement) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      showToast("Choose a PNG, JPG or WebP image.");
      imageInput.value = "";
      return;
    }
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const image = new Image();
      image.onload = () => {
        const width = Math.min(200, Math.max(60, image.naturalWidth > 0 ? 150 : 120));
        const height = width * image.naturalHeight / image.naturalWidth;
        addHistoryPoint();
        editsFor(currentPage).push({ type: "image", x: imagePlacement.x, y: imagePlacement.y, w: width, h: height, dataUrl, mime: file.type, ...viewportMetadata() });
        redrawAnnotations();
        updateEditCount();
        showToast("Image added. Download to embed it in the PDF.");
        imagePlacement = null;
        imageInput.value = "";
      };
      image.onerror = () => showToast("Could not read this image.");
      image.src = dataUrl;
    } catch (error) {
      console.error(error);
      showToast("Could not load the image.");
    }
  }

  annotationCanvas.addEventListener("click", event => {
    if (!pdfDocument || busy || gesture) return;
    const point = pointerPosition(event);
    if (activeTool === "text") addTextAt(point);
    else if (activeTool === "image") placeImageAt(point);
  });

  annotationCanvas.addEventListener("pointerdown", event => {
    if (!pdfDocument || busy || activeTool === "select" || activeTool === "text" || activeTool === "image") return;
    event.preventDefault();
    annotationCanvas.setPointerCapture(event.pointerId);
    const point = pointerPosition(event);
    const type = activeTool;
    gesture = {
      type,
      points: [point],
      color: type === "highlight" ? "#ffe66b" : type === "signature" ? "#18244a" : "#20243a",
      width: type === "signature" ? 2.8 : 2.2
    };
  });

  annotationCanvas.addEventListener("pointermove", event => {
    if (!gesture) return;
    gesture.points.push(pointerPosition(event));
    if (gesture.type === "draw" || gesture.type === "signature") {
      redrawAnnotations(gesture);
    } else redrawAnnotations(gesture);
  });

  function finishGesture() {
    if (!gesture) return;
    const finished = gesture;
    gesture = null;
    if (finished.type === "draw" || finished.type === "signature") {
      if (finished.points.length < 2) return redrawAnnotations();
      addHistoryPoint();
      editsFor(currentPage).push({ type: "path", points: finished.points, color: finished.color, width: finished.width, ...viewportMetadata() });
      redrawAnnotations();
      updateEditCount();
      showToast(finished.type === "signature" ? "Signature stroke added." : "Drawing added.");
      return;
    }
    if (finished.points.length < 2) return redrawAnnotations();
    const a = finished.points[0], b = finished.points[finished.points.length - 1];
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    if (w < 3 || h < 3) return redrawAnnotations();
    if (finished.type === "highlight") {
      addHistoryPoint();
      editsFor(currentPage).push({ type: "highlight", x, y, w, h, color: "#ffe66b", ...viewportMetadata() });
      redrawAnnotations();
      updateEditCount();
      showToast("Highlight added.");
    } else if (finished.type === "replace") {
      const replacement = window.prompt("Enter replacement text (the area will be visually covered):");
      if (replacement === null) return redrawAnnotations();
      const rawSize = window.prompt("Replacement text size (8–36):", "13");
      if (rawSize === null) return redrawAnnotations();
      const fontSize = Math.max(8, Math.min(36, Number(rawSize) || 13));
      addHistoryPoint();
      const view = viewportMetadata();
      editsFor(currentPage).push({ type: "cover", x, y, w, h, ...view });
      editsFor(currentPage).push({ type: "text", x: x + 3, y: y + 2, text: replacement, fontSize, color: "#20243a", ...view });
      redrawAnnotations();
      updateEditCount();
      showToast("Area covered and replacement added. This is visual replacement, not source-text rewriting.");
    }
  }
  annotationCanvas.addEventListener("pointerup", finishGesture);
  annotationCanvas.addEventListener("pointercancel", finishGesture);

  function changePage(delta) {
    const pages = visiblePages();
    const index = pages.indexOf(currentPage);
    const next = pages[index + delta];
    if (next) {
      currentPage = next;
      renderCurrentPage();
    }
  }

  $("openButton").addEventListener("click", () => fileInput.click());
  $("welcomeOpenButton").addEventListener("click", () => fileInput.click());
  $("sideOpenButton").addEventListener("click", () => fileInput.click());
  $("mobileOpenButton").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    await openPdfFile(file);
    fileInput.value = "";
  });
  $("downloadButton").addEventListener("click", exportPdf);
  $("sideSaveButton").addEventListener("click", exportPdf);
  $("extractButton").addEventListener("click", extractCurrentPage);
  $("mergeButton").addEventListener("click", () => mergeInput.click());
  $("sideMergeButton").addEventListener("click", () => mergeInput.click());
  mergeInput.addEventListener("change", () => mergePdfFiles(mergeInput.files));
  imageInput.addEventListener("change", imageInputChanged);
  $("prevPageButton").addEventListener("click", () => changePage(-1));
  $("nextPageButton").addEventListener("click", () => changePage(1));
  $("pageNumber").addEventListener("change", () => {
    if (!pdfDocument) return;
    const value = Math.max(1, Math.min(pdfDocument.numPages, Number($("pageNumber").value) || 1));
    const pages = visiblePages();
    currentPage = pages.includes(value) ? value : (pages.find(n => n >= value) || pages[pages.length - 1]);
    renderCurrentPage();
  });
  $("zoomInButton").addEventListener("click", () => { zoomFactor = Math.min(2.6, zoomFactor + .15); renderCurrentPage(); });
  $("zoomOutButton").addEventListener("click", () => { zoomFactor = Math.max(.5, zoomFactor - .15); renderCurrentPage(); });
  $("rotateButton").addEventListener("click", () => {
    if (!pdfDocument) return;
    pageRotations[currentPage] = ((pageRotations[currentPage] || 0) + 90) % 360;
    renderCurrentPage();
    showToast("Page rotated. Download to save the change.");
  });
  $("deletePageButton").addEventListener("click", () => {
    if (!pdfDocument) return;
    if (visiblePages().length <= 1) return showToast("At least one page must remain in the PDF.");
    if (!window.confirm("Mark page " + currentPage + " for removal from the exported PDF?")) return;
    deletedPages.add(currentPage);
    const next = visiblePages().find(n => n > currentPage) || visiblePages().slice(-1)[0];
    currentPage = next;
    updatePageUI();
    renderCurrentPage();
    showToast("Page marked for removal. Download to apply it.");
  });
  $("undoButton").addEventListener("click", undo);
  $("redoButton").addEventListener("click", redo);
  document.querySelectorAll("[data-tool]").forEach(button => button.addEventListener("click", () => setTool(button.dataset.tool)));

  const dropZone = $("dropZone");
  ["dragenter", "dragover"].forEach(type => dropZone.addEventListener(type, event => {
    event.preventDefault();
    dropZone.classList.add("drag-over");
  }));
  ["dragleave", "drop"].forEach(type => dropZone.addEventListener(type, event => {
    event.preventDefault();
    dropZone.classList.remove("drag-over");
  }));
  dropZone.addEventListener("drop", event => {
    const file = Array.from(event.dataTransfer.files || []).find(item => item.type === "application/pdf" || item.name.toLowerCase().endsWith(".pdf"));
    if (file) openPdfFile(file); else showToast("Drop a PDF file to open it.");
  });

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installPrompt = event;
    $("installButton").classList.remove("hidden");
  });
  $("installButton").addEventListener("click", async () => {
    if (!installPrompt) return showToast("Use your browser menu and choose Install app or Add to Home screen.");
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $("installButton").classList.add("hidden");
  });
  window.addEventListener("resize", () => {
    if (pdfDocument) renderCurrentPage();
  });

  if (!window.pdfjsLib || !window.PDFLib) {
    window.addEventListener("load", () => setTimeout(() => {
      if (!window.pdfjsLib || !window.PDFLib) showToast("PDF libraries did not load. Check your connection and reload.", 6000);
    }, 1200));
  }
  setTool("select");
})();
