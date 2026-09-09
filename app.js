const form = document.getElementById('editorForm');
const videoInput = document.getElementById('video');
const videoLabel = document.getElementById('videoLabel');
const dropZone = document.getElementById('dropZone');
const runButton = document.getElementById('runButton');
const stateLabel = document.getElementById('stateLabel');
const progressMessage = document.getElementById('progressMessage');
const progressPct = document.getElementById('progressPct');
const progressBar = document.getElementById('progressBar');
const preview = document.getElementById('preview');
const summary = document.getElementById('summary');
const actions = document.getElementById('actions');
const downloadButton = document.getElementById('downloadButton');
const planButton = document.getElementById('planButton');
const planView = document.getElementById('planView');
const apiPill = document.getElementById('apiPill');
let activeJob = null;

fetch('/api/health').then(r=>r.json()).then(h=>{
  apiPill.textContent = h.ai_configured ? `AI ready · ${h.editor_model}` : 'AI key not configured';
  if(h.ai_configured) apiPill.classList.add('ready');
}).catch(()=>apiPill.textContent='Server offline');

videoInput.addEventListener('change',()=>{
  if(videoInput.files[0]) videoLabel.textContent = videoInput.files[0].name;
});
['dragenter','dragover'].forEach(evt=>dropZone.addEventListener(evt,e=>{e.preventDefault();dropZone.classList.add('drag')}));
['dragleave','drop'].forEach(evt=>dropZone.addEventListener(evt,e=>{e.preventDefault();dropZone.classList.remove('drag')}));
dropZone.addEventListener('drop',e=>{
  const f=e.dataTransfer.files?.[0]; if(!f)return;
  const dt=new DataTransfer();dt.items.add(f);videoInput.files=dt.files;videoLabel.textContent=f.name;
});

form.addEventListener('submit', async (e)=>{
  e.preventDefault();
  if(!videoInput.files[0]) return;
  runButton.disabled=true; actions.classList.add('hidden'); planView.classList.add('hidden'); summary.classList.add('hidden');
  setProgress(3,'Uploading video','uploading');
  const fd = new FormData(form);
  fd.set('burn_captions', form.burn_captions.checked ? 'true':'false');
  fd.set('keep_original_audio', form.keep_original_audio.checked ? 'true':'false');
  if(!fd.get('overlay_audio_at')) fd.delete('overlay_audio_at');
  try{
    const res = await fetch('/api/jobs',{method:'POST',body:fd});
    const data = await res.json();
    if(!res.ok) throw new Error(data.detail || 'Upload failed');
    activeJob=data.job_id;
    pollJob();
  }catch(err){
    setProgress(100,err.message,'error');runButton.disabled=false;
  }
});

function setProgress(p,msg,state){
  progressBar.style.width=`${p}%`;progressPct.textContent=`${p}%`;progressMessage.textContent=msg;stateLabel.textContent=state;
}

async function pollJob(){
  if(!activeJob)return;
  try{
    const res=await fetch(`/api/jobs/${activeJob}`);const job=await res.json();
    setProgress(job.progress||0,job.message||'',job.state||'running');
    if(job.state==='done'){
      runButton.disabled=false;
      summary.textContent=job.summary||'Edit complete';summary.classList.remove('hidden');
      actions.classList.remove('hidden');downloadButton.href=job.download_url;
      preview.innerHTML=`<video controls playsinline src="${job.download_url}?v=${Date.now()}"></video>`;
      return;
    }
    if(job.state==='error'){runButton.disabled=false;summary.textContent=job.message;summary.classList.remove('hidden');return;}
    setTimeout(pollJob,1200);
  }catch(err){setProgress(100,err.message,'error');runButton.disabled=false;}
}

planButton.addEventListener('click',async()=>{
  if(!activeJob)return;
  const res=await fetch(`/api/jobs/${activeJob}/plan`);const plan=await res.json();
  planView.textContent=JSON.stringify(plan,null,2);planView.classList.toggle('hidden');
});
