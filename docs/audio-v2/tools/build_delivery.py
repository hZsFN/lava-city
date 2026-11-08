"""Build the offline audition page, curated reel, catalog and runtime ZIP."""
from pathlib import Path
import html, json, subprocess, wave, zipfile
import numpy as np
import imageio_ffmpeg
from export_and_verify import loudness
ROOT=Path(__file__).resolve().parents[1]
SR=44100
FF=imageio_ffmpeg.get_ffmpeg_exe()
# Epic battle loops open with a quiet braam intro; excerpts start at the theme (bar 13) / climax (bar 25).
EXCERPT={'bgm-boss-phase1':19.2,'bgm-boss-phase2':38.4}

def decode(name):
    p=subprocess.run([FF,'-v','error','-i',str(ROOT/'masters'/f'{name}.wav'),'-f','f32le','-ac','2','-'],capture_output=True,check=True)
    return np.frombuffer(p.stdout,dtype='<f4').reshape(-1,2).astype(float)

def make_reel():
    x=np.zeros((60*SR,2))
    cues=[]
    sections=[('bgm-molten-heart',0,11,'00:00 深渊苏醒'),('bgm-boss-phase1',10,15,'00:10 岩甲交锋'),
              ('bgm-boss-phase2',24,16,'00:24 熔火反击'),('bgm-rage',39,12,'00:39 熔岩狂暴'),('bgm-victory',51,7.5,'00:51 击破后的胜利')]
    for name,at,dur,label in sections:
        s0=round(EXCERPT.get(name,0)*SR);y=decode(name)[s0:s0+round(dur*SR)].copy()
        fade=min(SR,len(y)//3)
        y[:fade]*=np.linspace(0,1,fade)[:,None]; y[-fade:]*=np.linspace(1,0,fade)[:,None]
        s=round(at*SR); x[s:s+len(y)]+=y*.7; cues.append(label)
    for name,at in [('sfx-tower-build',7),('sfx-physical-shot-a',14),('sfx-arcane-shot-a',18),
                    ('sfx-weakness-open',22),('sfx-execution',25),('sfx-boss-slam',36),('sfx-execution',50)]:
        if not (ROOT/'masters'/f'{name}.wav').exists(): continue
        y=decode(name); s=round(at*SR); n=min(len(y),len(x)-s)
        x[s:s+n]+=y[:n]*.75
    p=float(np.max(np.abs(x)))
    if p>.7: x*=.7/p
    with wave.open(str(ROOT/'preview'/'showcase.wav'),'wb') as f:
        f.setnchannels(2); f.setsampwidth(2); f.setframerate(SR); f.writeframes(np.round(x*32767).astype('<i2').tobytes())
    subprocess.run([FF,'-y','-v','error','-i',str(ROOT/'preview'/'showcase.wav'),'-c:a','libvorbis','-q:a','5',str(ROOT/'preview'/'showcase.ogg')],check=True)
    (ROOT/'preview'/'cue-sheet.txt').write_text('\n'.join(cues)+'\n音乐与音效混合预览；各原素材见 web/ 与 masters/。\n',encoding='utf-8')

def make_comparison():
    chunks=[]; cues=[]; cursor=0.
    for name,desc in [('bgm-boss-phase1','岩甲阶段'),('bgm-boss-phase2','熔火阶段')]:
        for version,folder in [('V1',ROOT.parent),('V2',ROOT)]:
            source=folder/'masters'/f'{name}.wav'
            start=EXCERPT.get(name,0) if version=='V2' else 0
            p=subprocess.run([FF,'-v','error','-ss',str(start),'-i',str(source),'-t','12','-ac','2','-f','f32le','-'],capture_output=True,check=True)
            y=np.frombuffer(p.stdout,dtype='<f4').reshape(-1,2).copy()
            f=min(4410,len(y)//4); y[:f]*=np.linspace(0,1,f)[:,None]; y[-f:]*=np.linspace(1,0,f)[:,None]
            clip=ROOT/'preview'/f'comparison-{version.lower()}-{name}.wav'
            with wave.open(str(clip),'wb') as w:
                w.setnchannels(2);w.setsampwidth(2);w.setframerate(SR);w.writeframes(np.round(y*32767).astype('<i2').tobytes())
            stats=loudness(clip)
            gain=min(-20-stats['input_i'],-3-stats['input_tp'])
            y*=10**(gain/20)
            chunks.append(y);chunks.append(np.zeros((round(.75*SR),2)))
            cues.append({'start_seconds':cursor,'version':version,'title':desc,'target_lufs':-20,'source_excerpt_lufs':stats['input_i'],'gain_db':gain})
            cursor+=12.75
    x=np.concatenate(chunks[:-1],axis=0)
    with wave.open(str(ROOT/'preview'/'boss-ab.wav'),'wb') as w:
        w.setnchannels(2);w.setsampwidth(2);w.setframerate(SR);w.writeframes(np.round(x*32767).astype('<i2').tobytes())
    subprocess.run([FF,'-y','-v','error','-i',str(ROOT/'preview'/'boss-ab.wav'),'-c:a','libvorbis','-q:a','5',str(ROOT/'preview'/'boss-ab.ogg')],check=True)
    (ROOT/'preview'/'boss-ab-cues.json').write_text(json.dumps(cues,ensure_ascii=False,indent=2),encoding='utf-8')

def waveform(name):
    x=decode(name)
    bins=np.array_split(np.max(np.abs(x),axis=1),100)
    v=np.array([float(np.max(a)) for a in bins]); v/=max(v.max(),1e-8)
    bars=''.join(f'<rect x="{i*3}" y="{20-vv*18:.2f}" width="2" height="{max(1,vv*36):.2f}" rx="1"/>' for i,vv in enumerate(v))
    return '<svg viewBox="0 0 300 40" aria-hidden="true">'+bars+'</svg>'

def main():
    data=json.loads((ROOT/'manifest.json').read_text(encoding='utf-8'))
    assets=sorted(data['assets'],key=lambda a:(0 if a['category']=='music' else 1,0 if a.get('revision_status')=='new' else 1,a['id']))
    make_reel(); make_comparison()
    labels={'music':'音乐','sfx':'音效','ui':'界面','ambience':'环境'}
    counts={k:sum(a['category']==k for a in assets) for k in labels}
    rows=[]; cards=[]
    for a in assets:
        name=a['id']; title=html.escape(a['title']); usage=html.escape(a['usage'])
        tag=labels[a['category']]; mode='循环' if a['loop'] else '单次'
        revision=a.get('revision_status','retained'); badge={'new':'新增','reworked':'精修重制','retained':'沿用'}[revision]
        rows.append(f"| `{name}` | {a['title']} | {tag} | {a['duration_seconds']:.2f} s | {mode} | {a['measured_ogg_lufs']} | {a['measured_ogg_true_peak_dbtp']} |")
        cards.append(f'''<article class="card" data-revision="{revision}" data-category="{a['category']}" data-search="{html.escape(name+' '+a['title']+' '+a['usage'],quote=True)}">
<div class="top"><span class="type">{badge} · {tag} / {mode}</span><span>{a['duration_seconds']:.2f}s · {a.get('bpm') or '—'} BPM</span></div>
<h2>{title}</h2><code>{name}</code>{waveform(name)}<p>{usage}</p>
<audio controls preload="none" {'loop' if a['loop'] else ''} aria-label="{title}"><source src="{a['files']['ogg']}" type="audio/ogg"><source src="{a['files']['wav']}" type="audio/wav"></audio>
<div class="links"><a href="{a['files']['ogg']}" download>OGG</a><a href="{a['files']['wav']}" download>WAV 母带</a><span>{a['measured_ogg_lufs'] if a['measured_ogg_lufs'] is not None else '短音'} LUFS · {a['measured_ogg_true_peak_dbtp']} dBTP</span></div></article>''')
    (ROOT/'CATALOG.md').write_text('# 音频素材清单\n\n所有素材均为本次独立制作，尚未接入游戏。LUFS/真峰值为 OGG 实测。短于响度门限的声音以 RMS 控制电平，LUFS 显示 None。\n\n| 文件 ID | 标题 | 分类 | 时长 | 播放 | LUFS | dBTP |\n|---|---|---|---:|---|---:|---:|\n'+'\n'.join(rows)+'\n',encoding='utf-8')
    css='''*{box-sizing:border-box}body{margin:0;background:#101114;color:#eee9e1;font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1260px;margin:auto;padding:48px 28px}.eyebrow{color:#f3ad6b;letter-spacing:.25em;font-size:12px}h1{font-size:46px;line-height:1.2;margin:14px 0}header p{color:#b6b3ac;max-width:720px}.stats{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0}.stats span{padding:8px 16px;background:#242126;border:1px solid #3a3130;border-radius:8px}.hero{border:1px solid #5c4033;background:linear-gradient(110deg,#35231e,#1b2029);border-radius:14px;padding:24px;margin:24px 0}.hero h2{margin:0}.hero audio{max-width:700px}.controls{display:flex;gap:10px;flex-wrap:wrap;position:sticky;top:0;padding:16px 0;background:#101114f2;z-index:2}input,button,select{border:1px solid #47464b;border-radius:8px;background:#202126;color:#eee9e1;padding:10px 14px;font:inherit}input{flex:1;min-width:210px}button{cursor:pointer}button:hover{border-color:#f3ad6b}button:focus-visible,a:focus-visible{outline:2px solid #7dd3e8;outline-offset:3px}#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px}.card{padding:20px;border:1px solid #34343b;border-radius:12px;background:#1a1b20}.top,.links{display:flex;justify-content:space-between;gap:12px;font-size:12px;color:#aaa5a1}.type{color:#f3ad6b}.card h2{font-size:20px;margin:12px 0 0}.card code{font-size:11px;color:#a4a7b5;overflow-wrap:anywhere}.card p{font-size:13px;color:#bebbb5;min-height:62px}.card svg{width:100%;height:40px;margin-top:16px;fill:#cf8962}.card[data-category=music] svg{fill:#7cb5c3}audio{width:100%;height:42px;margin:10px 0}.links{align-items:center;flex-wrap:wrap}a{color:#9ad5e5;text-decoration:none}a:hover{text-decoration:underline}footer{margin:38px 0;color:#999;font-size:13px}[hidden]{display:none!important}#count{color:#b6b3ac;margin-bottom:14px}@media(max-width:600px){main{padding:28px 16px}h1{font-size:34px}.hero{padding:18px}}'''
    page='''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>熔心孤塔 · 声音素材库</title><style>CSS</style></head><body><main><header><div class="eyebrow">MOLTEN HEART / AUDIO COLLECTION 01</div><h1>熔心孤塔 · 声音素材库</h1><p>从岩层深处的心跳，到熔火形态的反击。按游戏文档与事件契约制作的独立音频包。</p><div class="stats">STATS</div></header><section class="hero"><h2>先听 60 秒精选</h2><p>苏醒 → 岩甲交锋 → 熔火反击 → 狂暴 → 胜利，穿插建塔、武器与击破反馈。</p><audio controls preload="metadata" aria-label="60秒声音精选"><source src="preview/showcase.ogg" type="audio/ogg"><source src="preview/showcase.wav" type="audio/wav"></audio><div><a href="CATALOG.md">完整清单</a> · <a href="INTEGRATION.md">接入说明</a> · <a href="manifest.json">素材参数</a> · <a href="runtime-audio.zip" download>下载运行时素材包</a></div></section><div class="controls"><input id="search" aria-label="搜索音频" placeholder="搜索名称、武器、事件或用途…"><select id="category" aria-label="按分类筛选"><option value="all">全部声音</option><option value="music">音乐</option><option value="sfx">音效</option><option value="ambience">环境</option><option value="ui">界面</option></select><button id="stop">停止播放</button></div><p id="count" aria-live="polite"></p><section id="grid">CARDS</section><footer>点击播放后才会发声；同时只试听一项。标记“循环”的素材默认循环播放。<br>本页支持双击离线打开，无外部依赖。文件技术检查已执行；主观听感与游戏内混音请试听确认。<br>全部素材由本地程序合成，无外部采样。原游戏目录保持只读，本包尚未接入游戏。</footer></main><script>
const audios=[...document.querySelectorAll('audio')];
audios.forEach(a=>a.addEventListener('play',()=>audios.forEach(b=>{if(a!==b)b.pause()})));
document.getElementById('stop').onclick=()=>audios.forEach(a=>{a.pause();a.currentTime=0});
const search=document.getElementById('search'),category=document.getElementById('category'),cards=[...document.querySelectorAll('.card')];
function filter(){let n=0;const q=search.value.toLowerCase();cards.forEach(c=>{c.hidden=!(c.dataset.search.toLowerCase().includes(q)&&(category.value==='all'||c.dataset.category===category.value));if(!c.hidden)n++});document.getElementById('count').textContent=`显示 ${n} / ${cards.length} 项素材`}
search.oninput=filter;category.onchange=filter;filter();
</script></body></html>'''
    stats=''.join(f'<span>{n} 项{labels[k]}</span>' for k,n in counts.items() if n)+f'<span>OGG 总计 {data["web_total_bytes"]/1024/1024:.2f} MiB</span>'
    page=page.replace('CSS',css).replace('STATS',stats).replace('CARDS','\n'.join(cards))
    page=page.replace('AUDIO COLLECTION 01','AUDIO COLLECTION 02 / REFORGED')
    page=page.replace('熔心孤塔 · 声音素材库','熔心孤塔 · 声音精修 V2')
    page=page.replace('从岩层深处的心跳，到熔火形态的反击。按游戏文档与事件契约制作的独立音频包。','Boss 战以 150 BPM 史诗战歌原创重写：3+3+2 鲜明重音、太鼓与铁砧锻打、熔岩轰鸣；新增布防、战术音乐，以及移动、技能和操作反馈。')
    featured='''<section class="hero"><div class="eyebrow">BOSS MUSIC / 150 BPM</div><h2>熔心燃尽 · 烈焰战歌</h2><p>3+3+2 重音的太鼓与弦乐断奏、原创铜管主题、braam 熔岩轰鸣。51.2 秒完整循环，可先从这里试听。</p><audio controls loop preload="none" aria-label="新版Boss第二阶段音乐"><source src="web/bgm-boss-phase2.ogg" type="audio/ogg"><source src="masters/bgm-boss-phase2.wav" type="audio/wav"></audio><h2>旧版 / 新版 · 同响度对比</h2><p>0:00 一阶段 V1 → 0:12.75 一阶段 V2（主题段）→ 0:25.50 二阶段 V1 → 0:38.25 二阶段 V2（高潮段）。片段匹配至 -20 LUFS，便于比较编曲变化。</p><audio controls preload="none" aria-label="Boss音乐同响度对比"><source src="preview/boss-ab.ogg" type="audio/ogg"><source src="preview/boss-ab.wav" type="audio/wav"></audio><a href="PROJECT_PROGRESS.md">项目进度核查</a> · <a href="CHANGELOG.md">本轮变化</a> · <a href="../index-v1.html">第一版试听</a></section>'''
    page=page.replace('</header>','</header>'+featured)
    page=page.replace('<button id="stop">','<select id="revision" aria-label="按版本变化筛选"><option value="all">全部版本变化</option><option value="new">仅新增</option><option value="reworked">仅精修</option><option value="retained">沿用素材</option></select><button id="stop">')
    page=page.replace("const search=document.getElementById('search'),category=document.getElementById('category'),cards=", "const search=document.getElementById('search'),category=document.getElementById('category'),revision=document.getElementById('revision'),cards=")
    page=page.replace("category.value===c.dataset.category", "category.value===c.dataset.category")
    page=page.replace("category.value==='all'||c.dataset.category===category.value));", "category.value==='all'||c.dataset.category===category.value)&&(revision.value==='all'||c.dataset.revision===revision.value));")
    page=page.replace('category.onchange=filter;filter();','category.onchange=filter;revision.onchange=filter;filter();')
    (ROOT/'index.html').write_text(page,encoding='utf-8')
    with zipfile.ZipFile(ROOT/'runtime-audio.zip','w',compression=zipfile.ZIP_DEFLATED) as z:
        for p in sorted((ROOT/'web').glob('*.ogg')): z.write(p,p.relative_to(ROOT).as_posix())
        for name in ['manifest.json','INTEGRATION.md','CATALOG.md','CHANGELOG.md','PROJECT_PROGRESS.md']:
            p=ROOT/name
            if p.exists(): z.write(p,name)
    print(f'Built audition page, 60s reel, catalog and runtime ZIP: {len(assets)} assets')
if __name__=='__main__': main()
