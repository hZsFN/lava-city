
const audios=[...document.querySelectorAll('audio')];
audios.forEach(a=>a.addEventListener('play',()=>audios.forEach(b=>{if(a!==b)b.pause()})));
document.getElementById('stop').onclick=()=>audios.forEach(a=>{a.pause();a.currentTime=0});
const search=document.getElementById('search'),category=document.getElementById('category'),revision=document.getElementById('revision'),cards=[...document.querySelectorAll('.card')];
function filter(){let n=0;const q=search.value.toLowerCase();cards.forEach(c=>{c.hidden=!(c.dataset.search.toLowerCase().includes(q)&&(category.value==='all'||c.dataset.category===category.value)&&(revision.value==='all'||c.dataset.revision===revision.value));if(!c.hidden)n++});document.getElementById('count').textContent=`显示 ${n} / ${cards.length} 项素材`}
search.oninput=filter;category.onchange=filter;revision.onchange=filter;filter();
