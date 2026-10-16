(() => {
  const $ = id => document.getElementById(id);
  const state = { token: null, recipients: [], sent: 0, failed: 0, duplicates: 0, skipped: 0, sending: false, tokenClient: null, user: null, connectedAt: null };
  const MAX_RECIPIENTS = 50;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function toast(message) { const el=$('toast'); el.textContent=message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove('show'),3500); }
  function setConnected(connected) {
    $('accountTitle').textContent = connected ? 'Gmail connected' : 'Gmail not connected';
    $('accountSubtitle').textContent = connected ? 'Ready to send from your account' : 'Connect to authorise sending';
    $('connectBtn').innerHTML = connected ? '<span class="google-g">G</span> Gmail connected' : '<span class="google-g">G</span> Connect Gmail';
    $('sideConnectBtn').textContent = connected ? 'Reconnect Gmail' : 'Connect Gmail';
    $('profileConnectBtn').textContent = connected ? 'Reconnect Gmail' : 'Connect Gmail';
    $('disconnectBtn').disabled = !connected;
    renderProfile();
    updateSendButton();
  }
  function renderProfile() {
    const connected = Boolean(state.token);
    $('profileName').textContent = state.user?.name || (connected ? 'Google account connected' : 'Not connected');
    $('profileEmail').textContent = state.user?.email || (connected ? 'Account email unavailable' : 'Connect Gmail to view account details');
    $('profileAvatar').textContent = (state.user?.name || state.user?.email || '?').trim().charAt(0).toUpperCase();
    $('profileConnection').textContent = connected ? 'Connected' : 'Not connected';
    $('profilePermission').textContent = connected ? 'Granted for this session' : 'Not granted / disconnected';
    $('profileIdentityPermission').textContent = state.user ? 'Granted (email/profile)' : 'Not available';
    $('profileSession').textContent = connected && state.connectedAt ? 'Active since ' + state.connectedAt.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : 'No active session';
  }
  async function loadGoogleProfile(token) {
    try {
      const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {headers:{Authorization:'Bearer '+token}});
      if(!response.ok) throw new Error('Profile lookup failed');
      const profile = await response.json();
      state.user = {name:profile.name || '', email:profile.email || '', picture:profile.picture || ''};
    } catch (err) {
      state.user = null;
    }
    renderProfile();
  }
  function disconnectGmail() {
    if(state.sending){toast('Wait until the current campaign stops before disconnecting.');return;}
    if(state.token && window.google?.accounts?.oauth2?.revoke){
      google.accounts.oauth2.revoke(state.token, () => {});
    }
    state.token=null;state.user=null;state.connectedAt=null;setConnected(false);toast('Gmail disconnected from this session.');
  }
  function updateSendButton() {
    $('sendBtn').disabled = state.sending || !state.token || state.recipients.length===0 || !$('subject').value.trim() || !$('message').value.trim() || !$('consent').checked;
  }
  function parseCsv(text) {
    const rows=[]; let row=[], field='', quoted=false;
    for(let i=0;i<text.length;i++){
      const ch=text[i], next=text[i+1];
      if(ch==='"' && quoted && next==='"'){field+='"';i++;}
      else if(ch==='"'){quoted=!quoted;}
      else if(ch===',' && !quoted){row.push(field);field='';}
      else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&next==='\n')i++;row.push(field);if(row.some(v=>v.trim()))rows.push(row);row=[];field='';}
      else field+=ch;
    }
    if(field.length||row.length){row.push(field);if(row.some(v=>v.trim()))rows.push(row);}
    if(!rows.length) return [];
    const headers=rows.shift().map(v=>v.trim().toLowerCase().replace(/^\uFEFF/,''));
    const emailIndex=headers.findIndex(v=>['email','e-mail','email address','emailaddress'].includes(v));
    const nameIndex=headers.findIndex(v=>['name','full name','fullname','first name','firstname'].includes(v));
    const sendingIndex=headers.findIndex(v=>v==='sending');
    if(emailIndex<0) throw new Error('CSV needs a column named Email.');
    const seen=new Set(); state.duplicates=0; state.skipped=0; const list=[];
    for(const cells of rows){
      // If a Sending column exists, only rows explicitly marked Yes are eligible.
      // Accepted Yes values: yes, y, true, 1 (case-insensitive). No/blank/other values are skipped.
      if(sendingIndex>=0 && !['yes','y','true','1'].includes((cells[sendingIndex]||'').trim().toLowerCase())){
        state.skipped++; continue;
      }
      const email=(cells[emailIndex]||'').trim().toLowerCase();
      const name=nameIndex>=0?(cells[nameIndex]||'').trim():'';
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
      if(seen.has(email)){state.duplicates++;continue;}
      seen.add(email); list.push({email,name});
    }
    return list;
  }
  function updateStats() {
    $('statRecipients').textContent=state.recipients.length;
    $('statSent').textContent=state.sent;
    $('statFailed').textContent=state.failed;
    $('statDuplicates').textContent=state.duplicates;
    $('recipientCount').textContent=state.recipients.length+' contacts';
  }
  function renderRecipients() {
    const wrap=$('previewWrap'), fileRow=$('fileRow');
    if(!state.recipients.length){wrap.classList.add('hidden');fileRow.classList.add('hidden');updateStats();updateSendButton();return;}
    wrap.classList.remove('hidden');fileRow.classList.remove('hidden');
    $('previewBody').innerHTML=state.recipients.slice(0,8).map(r=>'<tr><td>'+escapeHtml(r.name||'—')+'</td><td>'+escapeHtml(r.email)+'</td></tr>').join('');
    if(state.recipients.length>8)$('previewBody').insertAdjacentHTML('beforeend','<tr><td colspan="2">+ '+(state.recipients.length-8)+' more recipients</td></tr>');
    $('fileMeta').textContent=state.recipients.length+' eligible recipients · '+state.duplicates+' duplicates removed'+(state.skipped?' · '+state.skipped+' rows skipped by Sending':'');
    updateStats();updateSendButton();
  }
  function escapeHtml(value){return String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
  async function readCsv(file){
    if(!file)return;
    if(!file.name.toLowerCase().endsWith('.csv')){toast('Please choose a CSV file.');return;}
    try{
      const text=await file.text(); const list=parseCsv(text);
      if(!list.length)throw new Error('No valid email addresses found. Check the Email column.');
      if(list.length>MAX_RECIPIENTS)throw new Error('This MVP allows up to '+MAX_RECIPIENTS+' unique recipients per campaign. Your CSV has '+list.length+'.');
      state.recipients=list;state.sent=0;state.failed=0;$('fileName').textContent=file.name;renderRecipients();toast('Loaded '+list.length+' valid recipients.');
    }catch(err){state.recipients=[];renderRecipients();toast(err.message||'Could not read this CSV.');}
    $('csvFile').value='';
  }
  function connectGmail(){
    if(!window.MAILBLASTER_CONFIG || !MAILBLASTER_CONFIG.GOOGLE_CLIENT_ID || MAILBLASTER_CONFIG.GOOGLE_CLIENT_ID.includes('PASTE_YOUR')){
      toast('Setup required: add your Google OAuth Client ID in config.js first.');return;
    }
    if(!window.google?.accounts?.oauth2){toast('Google sign-in is still loading. Please try again.');return;}
    state.tokenClient=google.accounts.oauth2.initTokenClient({
      client_id:MAILBLASTER_CONFIG.GOOGLE_CLIENT_ID,
      scope:'openid email profile https://www.googleapis.com/auth/gmail.send',
      callback: response=>{
        if(response.error){toast('Google authorisation failed: '+response.error);return;}
        state.token=response.access_token;state.connectedAt=new Date();state.user=null;setConnected(true);loadGoogleProfile(state.token);toast('Gmail connected for this session.');
      },
      error_callback:err=>toast('Google sign-in error: '+(err.message||err.type||'please try again'))
    });
    state.tokenClient.requestAccessToken({prompt:'consent'});
  }
  function b64(bytes){
    let binary='';const chunk=0x8000;
    for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));
    return btoa(binary);
  }
  function base64UrlUtf8(text){return b64(new TextEncoder().encode(text)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
  function wrap76(str){return str.match(/.{1,76}/g)?.join('\r\n')||'';}
  function makeRaw(recipient, subject, body){
    const encodedSubject='=?UTF-8?B?'+b64(new TextEncoder().encode(subject))+'?=';
    const encodedBody=wrap76(b64(new TextEncoder().encode(body.replace(/\r?\n/g,'\r\n'))));
    return base64UrlUtf8('To: '+recipient.email+'\r\nSubject: '+encodedSubject+'\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'+encodedBody);
  }
  function personalize(text, recipient){return text.replace(/\{\{\s*name\s*\}\}/gi,recipient.name||'there').replace(/\{\{\s*email\s*\}\}/gi,recipient.email);}
  async function sendOne(recipient, subject, body){
    const response=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{
      method:'POST',headers:{Authorization:'Bearer '+state.token,'Content-Type':'application/json'},
      body:JSON.stringify({raw:makeRaw(recipient,personalize(subject,recipient),personalize(body,recipient))})
    });
    if(response.status===401){state.token=null;state.user=null;state.connectedAt=null;setConnected(false);throw new Error('Gmail session expired. Reconnect Gmail to continue.');}
    if(!response.ok){let detail='Gmail API error ('+response.status+')';try{const data=await response.json();detail=data.error?.message||detail;}catch{}throw new Error(detail);}
    return response.json();
  }
  async function sendCampaign(){
    if(state.sending||!state.token||!state.recipients.length)return;
    const subject=$('subject').value.trim(), body=$('message').value.trim();
    if(!subject||!body){toast('Enter a subject and message first.');return;}
    if(!confirm('Send '+state.recipients.length+' separate emails from your connected Gmail account? Only proceed if these recipients opted in.'))return;
    state.sending=true;state.sent=0;state.failed=0;updateStats();updateSendButton();
    $('progressWrap').classList.remove('hidden');$('progressBar').style.width='0%';$('progressLabel').textContent='Sending campaign…';
    for(let i=0;i<state.recipients.length;i++){
      const recipient=state.recipients[i];
      $('progressCount').textContent=(i+1)+' / '+state.recipients.length;
      $('progressStatus').textContent='Sending to '+recipient.email;
      try{await sendOne(recipient,subject,body);state.sent++;}
      catch(err){state.failed++;$('progressStatus').textContent='Failed for '+recipient.email+': '+err.message;if(!state.token)break;}
      $('progressBar').style.width=Math.round(((i+1)/state.recipients.length)*100)+'%';updateStats();
      if(i<state.recipients.length-1 && state.token)await sleep(1800);
    }
    state.sending=false;updateSendButton();
    const finished=state.sent+state.failed;
    $('progressLabel').textContent=state.token?'Campaign finished':'Campaign paused — reconnect Gmail';
    $('progressCount').textContent=finished+' / '+state.recipients.length;
    $('progressStatus').textContent='Accepted by Gmail: '+state.sent+' · Failed: '+state.failed+'. Gmail acceptance does not guarantee inbox delivery.';
    toast('Campaign finished. Sent: '+state.sent+' · Failed: '+state.failed);
  }
  $('connectBtn').addEventListener('click',connectGmail);$('sideConnectBtn').addEventListener('click',connectGmail);$('profileConnectBtn').addEventListener('click',connectGmail);
  $('profileBtn').addEventListener('click',()=>{const panel=$('profilePanel'),open=panel.classList.toggle('hidden')===false;$('profileBtn').setAttribute('aria-expanded',String(open));if(open)renderProfile();});
  $('closeProfileBtn').addEventListener('click',()=>{$('profilePanel').classList.add('hidden');$('profileBtn').setAttribute('aria-expanded','false');});
  $('disconnectBtn').addEventListener('click',disconnectGmail);
  $('csvFile').addEventListener('change',e=>readCsv(e.target.files[0]));
  $('removeCsv').addEventListener('click',()=>{state.recipients=[];state.duplicates=0;renderRecipients();$('fileName').textContent='';});
  ['subject','message','consent'].forEach(id=>$(id).addEventListener('input',updateSendButton));
  $('consent').addEventListener('change',updateSendButton);$('sendBtn').addEventListener('click',sendCampaign);
  document.querySelectorAll('[data-token]').forEach(btn=>btn.addEventListener('click',()=>{
    const field=$('message'), token=btn.dataset.token, start=field.selectionStart, end=field.selectionEnd;
    field.setRangeText(token,start,end,'end');field.focus();updateSendButton();
  }));
  const dz=$('dropzone');
  ['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('dragover');}));
  ['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('dragover');}));
  dz.addEventListener('drop',e=>readCsv(e.dataTransfer.files[0]));
  updateStats();setConnected(false);
})();