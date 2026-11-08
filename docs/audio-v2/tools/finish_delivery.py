"""Write a measured V2 handoff and check delivery integrity without game writes."""
from pathlib import Path
from html.parser import HTMLParser
from datetime import datetime,timezone,timedelta
from collections import Counter
import hashlib,json,re,subprocess,zipfile
import numpy as np
from export_and_verify import decoded,loudness
ROOT=Path(__file__).resolve().parents[1]
OLD=ROOT.parent

class Links(HTMLParser):
    def __init__(self): super().__init__();self.refs=[];self.cards=0
    def handle_starttag(self,tag,attrs):
        d=dict(attrs)
        for k in ['href','src']:
            if d.get(k):self.refs.append(d[k])
        if tag=='article' and d.get('class')=='card':self.cards+=1

def main():
    m=json.loads((ROOT/'manifest.json').read_text(encoding='utf-8'))
    old=json.loads((OLD/'manifest.json').read_text(encoding='utf-8'))
    originals=json.loads((ROOT/'reports'/'originals-verification.json').read_text(encoding='utf-8'))
    assets=m['assets'];counts=Counter(a['category'] for a in assets);revisions=Counter(a['revision_status'] for a in assets)
    assert m['all_passed']
    # Real event spelling check; metadata is descriptive, never automatically subscribed.
    source=(ROOT.parents[1]/'lava-city'/'src'/'core'/'events.ts').read_text(encoding='utf-8')
    event_names=set(re.findall(r'^  (\w+):\s*\{',source.split('export type EventName')[0],re.M))
    wrong=[(a['id'],e) for a in assets for e in a['events'] if e not in event_names]
    if wrong: raise RuntimeError('Unknown event names: '+str(wrong))
    comparisons=[]
    for a in assets:
        if a['revision_status']!='reworked':continue
        b=next(x for x in old['assets'] if x['id']==a['id'])
        x=decoded(OLD/b['files']['wav'],b['channels']);y=decoded(ROOT/a['files']['wav'],a['channels'])
        n=min(len(x),len(y));x=x[:n].astype(float);y=y[:n].astype(float)
        cosine=float(np.sum(x*y)/max(1e-12,np.sqrt(np.sum(x*x)*np.sum(y*y))))
        if abs(cosine)>.98:raise RuntimeError('Music appears to be only a gain change: '+a['id'])
        comparisons.append({'id':a['id'],'old_bpm':b['bpm'],'new_bpm':a['bpm'],
                            'old_lufs':b['measured_ogg_lufs'],'new_lufs':a['measured_ogg_lufs'],
                            'old_duration':b['duration_seconds'],'new_duration':a['duration_seconds'],
                            'normalized_waveform_similarity':cosine})
    (ROOT/'reports'/'music-revision-comparison.json').write_text(json.dumps(comparisons,ensure_ascii=False,indent=2),encoding='utf-8')
    page=(ROOT/'index.html').read_text(encoding='utf-8');parser=Links();parser.feed(page)
    missing=[p for p in parser.refs if not p.startswith(('http:','https:','#')) and not (ROOT/p).is_file()]
    if missing:raise RuntimeError('Missing local references: '+str(missing))
    assert parser.cards==len(assets)
    js=ROOT/'reports'/'preview-inline.js';js.write_text('\n'.join(re.findall(r'<script>(.*?)</script>',page,re.S)),encoding='utf-8')
    p=subprocess.run(['node','--check',str(js)],capture_output=True,text=True)
    if p.returncode:raise RuntimeError(p.stderr)
    with zipfile.ZipFile(ROOT/'runtime-audio.zip') as z:
        assert z.testzip() is None
        assert len([n for n in z.namelist() if n.endswith('.ogg')])==len(assets)
    reel=loudness(ROOT/'preview'/'showcase.ogg');ab=loudness(ROOT/'preview'/'boss-ab.ogg')
    assert reel['input_tp']<-1 and ab['input_tp']<-1
    report={'assets':len(assets),'all_signal_checks_passed':True,'categories':dict(counts),'revisions':dict(revisions),
        'references_checked':len(parser.refs),'missing_references':missing,'js_syntax':'pass','zip_crc':'pass',
        'metadata_event_spellings':'pass','music_revisions_verified':len(comparisons),
        'showcase_loudness':reel,'ab_loudness':ab,'browser_control':'unavailable: CUA Transport closed',
        'subjective_listening':'pending user audition','in_game_mix':'not integrated',
        'original_workspace_snapshot':originals,'write_scope':'molten-heart-audio only; no game writes'}
    (ROOT/'reports'/'delivery-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    now=datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M:%S Asia/Shanghai')
    peak=max(a['measured_ogg_true_peak_dbtp'] for a in assets)
    loops=[a for a in assets if a['loop']];seam=max(a['loop_endpoint_jump'] for a in loops)
    readme=f'''# 熔心孤塔 · 音频精修 V2

交付：{now}。本轮围绕“Boss 更有力、更激昂，其他音乐精修，并按最新进度补声音”制作。

## 直接试听

- [V2 试听页](index.html)：顶部是新版 Boss 二阶段，接着是同响度 V1/V2 对比，支持仅看新增/精修/沿用。
- [Boss 二阶段 WAV](masters/bgm-boss-phase2.wav) / [OGG](web/bgm-boss-phase2.ogg)。
- [50.25秒同响度对比](preview/boss-ab.wav)：一阶段V1→V2，二阶段V1→V2；各12秒，间隔0.75秒。片段目标 -20 LUFS，避免仅因音量更响而误判编曲。
- [60秒新版精选](preview/showcase.wav)；[运行时素材包](runtime-audio.zip)。
- [完整清单](CATALOG.md)、[项目进度核查](PROJECT_PROGRESS.md)、[接入说明](INTEGRATION.md)、[变更说明](CHANGELOG.md)。

## 实际交付

共 **{len(assets)}项**：{counts['music']}段音乐、{counts['sfx']}项音效、{counts['ui']}项UI、{counts['ambience']}项环境循环。其中 **{revisions['reworked']}项音乐重制、{revisions['new']}项新增、{revisions['retained']}项沿用**。

- `web/`：OGG游戏资源，{m['web_total_bytes']/1024/1024:.2f} MiB。
- `masters/`：44.1kHz PCM24 WAV，{m['master_total_bytes']/1024/1024:.2f} MiB。
- `runtime-audio.zip`：OGG与清单/接入资料，{(ROOT/'runtime-audio.zip').stat().st_size/1024/1024:.2f} MiB；不是完整游戏包。
- `raw/`：新版素材保留Float32合成源，沿用素材维持V1的PCM16源；不虚称增加原有精度。
- `metadata/`、`tools/`：用途/事件候选、独立种子与可重跑程序；全部本地合成，无外部采样。
- `preview/`：精选、同响度对比及段落时标；`reports/`：测量与文件核对证据。

V1音频、清单和生成脚本保留在父目录；[V1试听](../index-v1.html)。原试听入口 `../index.html` 改为指向 V2。游戏原文件没有被本轮写入。

## 音乐变化

Boss一阶段/二阶段（150 BPM、32小节）与狂暴（160 BPM、16小节）以史诗预告片风格原创重写：3+3+2 十六分重音型贯穿底鼓/太鼓/低音/弦乐断奏，底鼓侧链压低和声层让节拍更鲜明；原创铜管主题、合唱、低铜切分刺音，熔岩色彩来自 braam 轰鸣、次低频冲击、岩浆气泡、上升嘶声与铁砧锻打。段落为 braam 开场→驱动→主题→半速蓄力→高八度高潮；不含任何外部旋律、和声进行、采样或音频。Boss音乐导出目标-16 LUFS，探索-20、布防-19、战术-22、其他音乐-18；保留瞬态和峰值余量。

探索、转阶段、胜利、失败同步重写；增加布防与战术曲。不同BPM曲之间用淡化切换；战术曲是预备素材，不能当作已运行的游戏功能。失败音乐同时考虑最新主线 `PlayerDied` 直接失败的路径，并与 `MatchEnded` 去重。准确时长/BPM及编曲记录见manifest。

## 进度驱动的增补

已通过GitHub连接器核验合并PR及master源码，区别当前本地分支与最新主线。血量归零直接失败、不再自动复活；因此新增低血警告而未制作常规复活声。新增石地脚步、跳落、落熔岩、资源/槽位反馈、倒计时、建造拒绝，以及可击破/打断/技能辨识等预备音效。Boss逻辑和音频播放仍待主循环接入，Q/F相关调用也不能假设已经连通。

## 验证与边界

- **{len(assets)}/{len(assets)}音频技术检查通过**，无解码失败、静音资产或削波，最大真峰值{peak:.2f} dBTP。
- {len(loops)}个循环长度精确，最大编码端点跳变{seam:.6f} FS。短单发允许至多128采样的淡出尾差，要求起音对齐且省略尾低于-50dBFS；WAV保持准确编辑长度。
- {len(comparisons)}首旧音乐均验证为内容变更，非简单增益副本；对比与精选也完成解码/峰值测量。
- {len(parser.refs)}个本地引用存在，JS语法、ZIP完整性、素材事件拼写通过。
- 浏览器控制通道仍报 `Transport closed`，未声称完成本轮浏览器实播或人耳听感验收；用户可在本地页播放。未修改游戏接入，尚无真实战斗混音验证。
- 原工作区基线覆盖{originals['checked_files']}文件；核对发现{len(originals['changed'])}变化、{len(originals['added'])}新增、{len(originals['missing'])}缺失。原目录只读，未回滚其他开发活动；详见 `reports/originals-verification.json`。

## 复现

需要本机已有的Python、NumPy、SciPy、imageio-ffmpeg与Node；本轮没有安装依赖。

```powershell
python -B tools/generate_music.py
python -B tools/generate_battle_epic.py
python -B tools/generate_additional_sfx.py
python -B tools/export_and_verify.py
python -B tools/build_delivery.py
```

以上仅重写本V2目录的生成素材。沿用的32项源文件已保留，通常不必重生成。游戏打包只选用OGG；不要将母带与制作材料装进12MB的整游戏包限额。
'''
    (ROOT/'README.md').write_text(readme,encoding='utf-8')
    status=f'''# V2交付状态

- 更新时间：{now}
- 状态：本轮已完成。
- 授权：用户要求Boss更有力激昂、精修其他音乐、查询进度并增补音乐音效。
- 结果：{len(assets)}素材，{revisions['reworked']}重制/{revisions['new']}新增/{revisions['retained']}沿用；试听、对比、清单、ZIP、制作源码齐备。
- 写入范围：仅独立音频包；V1保留，根试听入口指向V2；原游戏/worktree只读。
- 验证：音频{len(assets)}/{len(assets)}通过；本地引用、JS语法、ZIP CRC、事件名称通过。
- 限制：未游戏内接入；主观听感待试听；浏览器控制不可用。
- 原文件核对：{originals['checked_files']}项，{len(originals['changed'])}变化/{len(originals['added'])}新增/{len(originals['missing'])}缺失，不回滚并行开发变动。
- 无安装、提交、上传、发布或对外消息。当前无渲染、导出或本地服务器在运行。
- 下一步：用户按同响度对比反馈音乐偏好；接入原项目须另行授权。
- 恢复：先读README、PROJECT_PROGRESS和manifest，不重做已交付素材。
'''
    (ROOT/'STATUS.md').write_text(status,encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='original_workspace_snapshot'},ensure_ascii=False))

if __name__=='__main__': main()
