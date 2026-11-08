"""Molten Heart V2: original, deterministic, sample-free score.

Boss score: 144 BPM; melodic brass calls, string ostinato, taiko/snare and bass.
All loop placements and room tails wrap at exact integer musical bars.
Writes only this v2 pack's bgm raw and metadata. python -B tools/generate_music.py
"""
from functools import lru_cache
import hashlib, json
import numpy as np
from scipy import signal
from common import ROOT, SR, clock, hz, env, room, write_asset

TAU=2*np.pi

def seed(name):
    return np.random.default_rng(int.from_bytes(hashlib.sha256(name.encode()).digest()[:8],'little'))

def place(dst,x,at=0,gain=1,pan=0,wrap=False):
    if x.ndim==1:
        p=(pan+1)*np.pi/4
        x=np.column_stack((x*np.cos(p),x*np.sin(p)))
    start=round(at*SR)
    if wrap:
        start%=len(dst)
        while len(x):
            count=min(len(x),len(dst)-start)
            dst[start:start+count]+=x[:count]*gain
            x=x[count:];start=0
    else:
        lo=max(0,start);hi=min(len(dst),start+len(x))
        if hi>lo:dst[lo:hi]+=x[lo-start:hi-start]*gain

def filt(x,cut,kind='lowpass'):
    return signal.sosfilt(signal.butter(2,cut,btype=kind,fs=SR,output='sos'),x,axis=0)

def shape(t,attack,hold,release):
    e=np.minimum(1,t/attack)**1.15
    e*=np.minimum(1,np.maximum(0,(hold+release-t)/release))**1.8
    return e

@lru_cache(maxsize=256)
def voice(kind,note,hold):
    release={'horn':.21,'strings':.16,'pad':1.5,'bell':1.8,'bass':.10,'choir':1.4}[kind]
    t=clock(hold+release);f=hz(note)
    vibrato=.0032*np.sin(TAU*4.8*t)*(1-np.exp(-t*4))
    phase=TAU*f*(t+vibrato/30)
    x=np.zeros(len(t))
    if kind=='horn':
        # Warm odd/even harmonic body with a moving attack, not a single alarm tone.
        for k in range(1,11):
            amp=(1+.5*np.exp(-((k*f-850)/550)**2))/k**1.35
            dynamic=.52+.48*(1-np.exp(-t*18))**(k*.23)
            x+=amp*dynamic*np.sin(k*phase+.055*k)
            x+=.16*amp*np.sin(k*phase*1.0021+.31)
        x=filt(x,3100)*shape(t,.033,hold,release)*.43
        x*=1-.09*np.minimum(1,t/max(hold,.01))
    elif kind in ('strings','pad'):
        for k in range(1,10):
            amp=1/k**(1.4 if kind=='strings' else 1.7)
            for detune,level,offset in [(1,.5,0),(.9987,.27,.7),(1.0019,.23,1.4)]:
                x+=amp*level*np.sin(k*phase*detune+offset)
        x=filt(x,2800 if kind=='strings' else 1900)
        x*=shape(t,.012 if kind=='strings' else .8,hold,release)*(.63 if kind=='strings' else .42)
        if kind=='strings':x*=.65+.35*np.exp(-t*8)
    elif kind=='bell':
        for ratio,amp,decay in [(1,1,1.25),(2.001,.24,2.8),(2.99,.08,3.7),(4.06,.035,5)]:
            x+=amp*np.sin(TAU*f*ratio*t)*np.exp(-t*decay)
        x*=shape(t,.008,hold,release)*.44
    elif kind=='bass':
        x=np.sin(phase)+.27*np.sin(2*phase)+.11*np.sin(3*phase)+.055*np.sin(4*phase)
        x*=shape(t,.006,hold,release)*(.55+.45*np.exp(-t*9))*.64
    else:
        for k in range(1,13):
            formant=.35+np.exp(-((k*f-630)/230)**2)+.4*np.exp(-((k*f-1150)/350)**2)
            x+=np.sin(k*phase)*formant/k**1.5
            x+=.20*np.sin(k*phase*1.0017+.9)*formant/k**1.7
        x=filt(x,2300)*shape(t,.65,hold,release)*.29
    return x.astype(np.float64)

@lru_cache(maxsize=32)
def drum(kind,variant=0):
    d={'kick':.65,'taiko':.75,'snare':.36,'tom':.45,'hat':.14,'crash':1.65,'rim':.14}[kind]
    t=clock(d);rng=seed(f'{kind}-{variant}');noise=rng.normal(size=len(t))
    if kind in ('kick','taiko','tom'):
        base={'kick':45,'taiko':72,'tom':118}[kind]*(1+variant*.025)
        ph=TAU*np.cumsum(base+(95 if kind=='kick' else 65)*np.exp(-t*28))/SR
        x=np.sin(ph)*np.exp(-t*(6.5 if kind=='kick' else 7.8))
        x+=.27*np.sin(ph*1.49+.2)*np.exp(-t*13)
        x+=.16*filt(noise,[250,3400],'bandpass')*np.exp(-t*48)
        if kind=='taiko':x+=.11*np.sin(TAU*base*2.72*t)*np.exp(-t*9)
    elif kind=='snare':
        x=.40*np.sin(TAU*185*t)*np.exp(-t*20)+.17*np.sin(TAU*338*t)*np.exp(-t*23)
        x+=.52*filt(noise,[900,6200],'bandpass')*np.exp(-t*15)
        x+=.16*filt(noise,[150,1300],'bandpass')*np.exp(-t*28)
    elif kind=='hat':
        x=filt(noise,[3000,6800],'bandpass')*np.exp(-t*38)*.20
    elif kind=='crash':
        x=filt(noise,[1400,6500],'bandpass')*np.exp(-t*3.1)*.21
        for f in [724,1029,1388,1803,2339]:x+=.025*np.sin(TAU*f*t)*np.exp(-t*3.5)
    else:
        x=.23*np.sin(TAU*460*t)*np.exp(-t*45)+.12*np.sin(TAU*1387*t)*np.exp(-t*52)
        x+=.06*filt(noise,4500)*np.exp(-t*70)
    return np.tanh(x*1.18)*shape(t,.001,d-.025,.025)

def chord(dst,notes,at,hold,level=.20,kind='pad',wrap=True):
    for i,note in enumerate(notes):
        place(dst,voice(kind,note,round(hold,5)),at,level,pan=(i-(len(notes)-1)/2)*.32,wrap=wrap)

def periodic_bed(seconds,rng,level=.03):
    n=round(seconds*SR);t=clock(seconds);x=np.zeros((n,2));fr=np.fft.rfftfreq(n,1/SR)
    spectral=np.exp(-(fr/230)**4)*(1-np.exp(-(fr/40)**4))
    for c in range(2):
        spec=(rng.normal(size=len(fr))+1j*rng.normal(size=len(fr)))*spectral
        wind=np.fft.irfft(spec,n=n);wind/=max(np.std(wind),1e-8)
        x[:,c]=wind*(.75+.25*np.sin(TAU*t/seconds*2+c))*.18*level
        for f,amp in [(hz(38),.7),(hz(45),.25)]:
            fq=round(f*seconds)/seconds
            x[:,c]+=np.sin(TAU*fq*t+.05*c)*amp*level
    return x

def master_bus(x,wet=.10,wrap=True):
    # Parallel saturation fills body without flattening all drum attacks.
    dry=x*.78+np.tanh(x*1.2)*.22
    return room(dry,wet,wrap=wrap)

def save(name,x,title,loop,usage,events,bpm,sections,changes):
    write_asset(name,x,title,'music',loop,usage,events,bpm)
    p=ROOT/'metadata'/f'{name}.json';m=json.loads(p.read_text(encoding='utf-8'))
    m.update(version=2,key='D minor / modal colour',arrangement=sections,revision_notes=changes,
             synthesis='Original deterministic additive/modal oscillators and filtered noise; no external samples',
             bars=round(len(x)/SR/(60/bpm*4),4) if loop else None)
    p.write_text(json.dumps(m,ensure_ascii=False,indent=2),encoding='utf-8')

ROOTS=[38,38,34,34,41,43,33,33]
CHORDS=[[50,57,62,65],[50,57,62,69],[46,53,58,62],[46,53,62,65],
        [53,57,60,65],[43,50,58,62],[45,52,57,61],[45,52,58,61]]
MELODY=[[(0,62,1.4),(1.5,69,.8),(2.5,65,.75),(3.5,67,.4)],
        [(0,69,1.3),(1.5,72,.8),(2.5,69,1.1)],
        [(0,70,1.4),(1.5,69,.7),(2.5,65,1.2)],
        [(0,62,2.0),(2.5,65,.8),(3.5,67,.4)],
        [(0,69,1.4),(1.5,72,.8),(2.5,77,1.2)],
        [(0,74,1.3),(1.5,70,.8),(2.5,69,.75),(3.5,67,.4)],
        [(0,64,1.3),(1.5,65,.8),(2.5,61,1.1)],
        [(0,61,1.2),(1.5,64,.7),(2.5,69,.75),(3.5,61,.4)]]

def battle(name,title,mode,bars):
    bpm=144;beat=60/bpm;barlen=4*beat;duration=bars*barlen
    x=periodic_bed(duration,seed(name),.025)
    rage=mode=='rage';phase2=mode=='boss2'
    for bar in range(bars):
        block=bar//8;h=bar%8;root=ROOTS[h];at=bar*barlen
        if rage:h=bar%4*2;root=ROOTS[h]
        breakdown=(not rage and block==1 and bar%8<4)
        lift=1.12 if block==2 or rage else 1
        chord(x,CHORDS[h],at-.10,barlen+.13,.14 if not breakdown else .18,wrap=True)
        # Stomping downbeat, syncopated second kick, snare backbeat and broad taiko.
        kicks=[(0,.86),(1.5,.58),(2,.65),(3.5,.48)]
        if breakdown:kicks=[(0,.64),(2.5,.46)]
        if rage:kicks+=[(.75,.35),(2.75,.35)]
        for pos,vol in kicks:place(x,drum('kick',bar%3),at+pos*beat,vol*.56*lift,wrap=True)
        for pos in ([2] if breakdown else [1,3]):
            place(x,drum('snare',bar%2),at+pos*beat,(.37 if phase2 or rage else .31)*lift,pan=.04,wrap=True)
            place(x,drum('taiko',(bar+1)%3),at+(pos+.012)*beat,.16,pan=-.25,wrap=True)
        for pos in ([0,2.75] if not breakdown else [1.5]):
            place(x,drum('taiko',bar%3),at+pos*beat,.26*lift,pan=.25 if pos else -.18,wrap=True)
        if not breakdown:
            for j in range(8):
                place(x,drum('hat',j%2),at+j*.5*beat,.21 if j%2==0 else .13,pan=(-1)**j*.42,wrap=True)
                if phase2 and block==2 and j%2:
                    place(x,drum('hat',0),at+(j*.5+.25)*beat,.075,pan=-.3,wrap=True)
        # Low string/bass rhythm is deliberately not identical to kick rhythm.
        bass_pattern=[(0,0),(.75,0),(1.5,12),(2,0),(2.75,7),(3.5,12)]
        if breakdown:bass_pattern=[(0,0),(1.5,7),(3,0)]
        for pos,interval in bass_pattern:
            place(x,voice('bass',root+interval,.20 if not breakdown else .38),at+pos*beat,.35*lift,wrap=True)
        ost=[0,7,12,7,3,7,12,10] if h not in (6,7) else [0,7,12,7,4,7,12,11]
        for j,n in enumerate(ost):
            if breakdown and j%2:continue
            hold=.12 if phase2 or rage else .16
            place(x,voice('strings',root+12+n,hold),at+j*.5*beat,.20*lift if not breakdown else .105,
                  pan=(-1)**j*.32,wrap=True)
            if (phase2 and not breakdown) or rage:
                place(x,voice('strings',root+24+n,hold),at+(j*.5+.017)*beat,.073*lift,pan=(-1)**(j+1)*.38,wrap=True)
        # An eight-bar theme, then a contrasting answer before the final return.
        if breakdown:
            seq=[(0,MELODY[h][0][1]-12,2.4),(2.75,MELODY[h][-1][1]-12,.8)]
        else:seq=MELODY[h]
        for pos,note,length in seq:
            note+=12 if rage or (phase2 and block==2 and h in (4,5)) else 0
            place(x,voice('horn',note,round(length*beat,5)),at+pos*beat,.24*lift if not breakdown else .17,pan=-.08,wrap=True)
            if (phase2 and block!=1) or (block==2 and h%2==0):
                # Lower octave instead of dense full chords preserves headroom for alerts.
                place(x,voice('horn',note-12,round(length*beat*.91,5)),at+(pos+.025)*beat,.105,pan=.16,wrap=True)
        if bar%4==0:
            place(x,drum('crash'),at,.32 if breakdown else .50,pan=.1,wrap=True)
        if bar%4==3:
            for j,pos in enumerate([2.5,2.75,3,3.5,3.75]):
                place(x,drum('tom',j%3),at+pos*beat,.13+.035*j,pan=(j-2)*.16,wrap=True)
            if bar%8==7:
                for j,pos in enumerate([3,3.25,3.5,3.75]):
                    place(x,drum('snare',j%2),at+pos*beat,.12+.025*j,pan=-.08,wrap=True)
    x=master_bus(x,.09,True)
    sections=([{'bars':'1–4','role':'高压主题与双倍弦乐'},{'bars':'5–8','role':'短暂收束再抬升'},{'bars':'9–12','role':'高八度冲刺与循环衔接'}] if rage else
              [{'bars':'1–8','role':'完整号角主题与战鼓'},{'bars':'9–16','role':'低八度回应、前四小节减法、后四小节重建'},{'bars':'17–24','role':'主题回归与高层加速，鼓过门闭环'}])
    save(name,x,title,True,f'MatchPhaseChanged.phase={mode}；144 BPM、{bars}小节，事件驱动切换；不同节奏曲目采用0.8–1.2秒淡化。',
         ['MatchPhaseChanged'],bpm,sections,
         ['从96提升至144 BPM并重新编曲','新增铜管主题/回应及八度弦乐','低鼓、战鼓、分层军鼓与4/8小节过门','段落留白和鼓组动态，不靠单纯放大音量'])

def calm(name,title,mode,bpm,bars):
    beat=60/bpm;barlen=beat*4;d=barlen*bars
    x=periodic_bed(d,seed(name),.075 if mode=='wake' else .045)
    span=4 if bars==16 else 2
    chords=[[50,57,62,65],[46,53,58,62],[43,50,58,65],[45,52,59,62]]
    roots=[38,34,43,33]
    for block,ch in enumerate(chords):
        chord(x,ch,block*span*barlen-.65,span*barlen-.15,.24 if mode=='wake' else .19,wrap=True)
        # Soft vowel texture is sparse and lower than the melodic calls.
        if mode!='prep':chord(x,[n+12 for n in ch[1:3]],block*span*barlen+.4,span*barlen-1.4,.075,'choir',True)
    for bar in range(bars):
        at=bar*barlen;block=bar//span;root=roots[block]
        if mode=='prep':
            for pos in (0,2):place(x,drum('taiko',bar%2),at+pos*beat,.16,pan=-.12,wrap=True)
            for j in range(8):
                place(x,drum('rim',j%2),at+j*.5*beat,.055 if j%2 else .09,pan=(-1)**j*.32,wrap=True)
                iv=[0,7,12,7,3,7,12,7][j]
                if block==3:iv=[0,7,12,7,2,7,12,7][j]
                place(x,voice('bell',root+24+iv,.18),at+j*.5*beat,.16 if j%2==0 else .10,pan=(-1)**j*.33,wrap=True)
            for pos in (0,1.5,3):place(x,voice('bass',root,.35),at+pos*beat,.15,wrap=True)
            if bar%4==3:
                for j in range(3):place(x,drum('tom',j),at+(2.5+j*.5)*beat,.09+j*.025,pan=(j-1)*.2,wrap=True)
        elif mode=='wake':
            if bar%2==0:
                place(x,drum('kick'),at,.14,wrap=True);place(x,drum('kick'),at+.28,.055,wrap=True)
            if bar%4==3:place(x,drum('rim'),at+2.5*beat,.08,pan=.4,wrap=True)
        else:
            if bar%2==0:place(x,voice('bass',root,1),at,.075,wrap=True)
        # Wake: questions and answers; prep: clearer forward planning; tactical: space.
        if mode=='prep' or bar%2==0:
            notes=[[62,69,65,67],[62,65,70,69],[67,70,69,65],[64,65,62,61]][block]
            for j,note in enumerate(notes):
                atnote=at+j*beat*(.75 if mode=='prep' else 1.5)
                kind='bell' if mode!='prep' else 'horn'
                length=.7 if kind=='bell' else .30
                place(x,voice(kind,note,length),atnote,.17 if mode=='wake' else (.105 if mode=='tactical' else .095),
                      pan=(-1)**j*.45,wrap=True)
        if mode=='wake' and bar in (6,14):
            place(x,voice('horn',69,1.5),at+.5*beat,.10,pan=.12,wrap=True)
    x=master_bus(x,.20 if mode=='wake' else (.15 if mode=='tactical' else .12),True)
    event=['TacticalViewChanged'] if mode=='tactical' else ['MatchPhaseChanged']
    usage=('预备曲/待接入：当前主入口未消费Q且不发布战术状态；未来TacticalViewChanged.open=true时可替换主音乐，转场/危险提示优先，不叠加主音乐。' if mode=='tactical' else
           f'MatchPhaseChanged.phase={mode}；独立循环，阶段切换淡化；原wake/prep共享逻辑可选拆分。')
    save(name,x,title,True,usage,event,bpm,[{'bars':f'{i*span+1}–{(i+1)*span}','role':r} for i,r in enumerate(['提出主题','温暖和声回应','空间展开','悬念回环'])],
         ['慢起音和声与稀疏主题重新配平','空间尾音按循环回卷','避免与战斗相同的持续高密度节奏'] if mode=='wake' else ['新增用途明确的专用循环','节拍与响度适合操作、界面及提示留白'])

def transition():
    d=10.;x=np.zeros((round(d*SR),2));beat=60/144
    # Distinct tension arc: rupture, vacuum, rebuilding roll, release into phase II.
    place(x,drum('kick'),0,.55);place(x,drum('crash'),0,.34,pan=-.2)
    chord(x,[38,50,57,63],0,2.2,.17,'pad',False)
    chord(x,[45,52,58,61],3.2,3.3,.22,'pad',False)
    rng=seed('transition');t=clock(4.4)
    wind=filt(rng.normal(size=len(t)),[250,3100],'bandpass')
    wind*=np.sin(np.pi*t/4.4)**2*(t/4.4)*.14
    place(x,wind,3.4,pan=.1)
    for j,note in enumerate([50,57,62,65,69,74,77,81]):
        place(x,voice('strings',note,.20),4+j*.42,.14+j*.01,pan=(-1)**j*.25)
    for j in range(12):
        pos=5.3+j*beat*.5
        place(x,drum('snare',j%2),pos,.08+j*.014,pan=-.04)
        if j%2:place(x,drum('tom',j%3),pos,.10+j*.012,pan=.2)
    place(x,drum('kick'),8,.65);place(x,drum('crash'),8,.45)
    chord(x,[50,57,62,65],8,1.0,.23,'horn',False)
    x=master_bus(x,.15,False);x[-int(SR*.5):]*=np.linspace(1,0,int(SR*.5))[:,None]**1.5
    save('bgm-phase-transition',x,'熔壳剥落 · 转阶段精修',False,
         'MatchPhaseChanged.phase=transition 单次；10秒先压后扬，阶段提前结束需淡出。',
         ['MatchPhaseChanged'],144,[{'seconds':'0–3','role':'岩壳冲击与留白'},{'seconds':'3–8','role':'上行弦乐与军鼓渐密'},{'seconds':'8–10','role':'铜管和弦释放'}],
         ['8秒扩为10秒完整转场','新增中段留白、渐密滚奏与落点和声'])

def ending(win):
    d=12. if win else 8.;x=np.zeros((round(d*SR),2));bpm=96;beat=60/bpm
    if win:
        sequence=[([50,57,62,65],0,2.3),([46,53,58,62],2.5,2.1),([43,50,58,62],4.8,1.6),([50,57,62,66],6.7,3.6)]
        for notes,at,hold in sequence:
            chord(x,notes,at,hold,.22,'pad',False)
            chord(x,[n+12 for n in notes[1:]],at+.10,hold,.08,'choir',False)
        melody=[(0,62,1.2),(.9,65,.65),(1.55,69,.8),(2.5,70,1.3),(3.6,69,.7),(4.4,67,1.),(5.4,69,.7),(6.2,74,1.8),(8.3,78,1.7)]
        for at,n,h in melody:
            place(x,voice('horn',n,h),at,.18,pan=-.07)
            place(x,voice('bell',n+12,.9),at+.08,.07,pan=.32)
        for at in [0,2.5,4.8,6.7]:place(x,drum('taiko'),at,.24)
        place(x,drum('crash'),6.7,.29)
        name='bgm-victory';title='余烬见光 · 胜利精修'
        changes=['7.5秒扩至12秒','主题完整回归，D小调向明亮D大和弦释放','长尾收束保留胜利后的空间']
    else:
        for notes,at,h in [([50,57,62,65],0,2.3),([46,53,58,61],2.4,2.1),([38,45,50,53],4.6,2.0)]:
            chord(x,notes,at,h,.23,'pad',False)
        for at,n,h in [(0,74,.7),(.9,69,1.1),(2.2,65,.9),(3.4,61,.7),(4.5,62,1.7)]:
            place(x,voice('bell',n,h),at,.21,pan=(at/6-.5)*.5)
            place(x,voice('horn',n-12,h),at,.055)
        place(x,drum('kick'),0,.30)
        name='bgm-defeat';title='沉入熔海 · 失败精修'
        changes=['6秒扩至8秒','用主题碎片下降回应，不仅低频下滑','留出沉降尾音与明确结束']
    x=master_bus(x,.18,False);tail=round(2*SR);x[-tail:]*=np.linspace(1,0,tail)[:,None]**1.5
    usage=('MatchEnded.result=win；单次，结算前淡出其他音乐。' if win else
           'MatchEnded.result=lose 或 PlayerDied 候选；当前主入口死亡直接failLevel可能不先发MatchEnded；同一局只播一次，淡出其他音乐。')
    save(name,x,title,False,usage,['MatchEnded'] if win else ['MatchEnded','PlayerDied'],bpm,
         [{'seconds':f'0–{d-2:g}','role':'主题与和声收束'},{'seconds':f'{d-2:g}–{d:g}','role':'尾音结束'}],changes)

if __name__=='__main__':
    battle('bgm-boss-phase1','岩甲之重 · 战鼓反击','boss1',24)
    battle('bgm-boss-phase2','熔心燃尽 · 烈焰奋战','boss2',24)
    battle('bgm-rage','最后余烬 · 极限冲刺','rage',12)
    calm('bgm-molten-heart','渊火回声 · 苏醒精修','wake',96,16)
    calm('bgm-preparation','石阵将启 · 布防','prep',120,16)
    calm('bgm-tactical','符文静思 · 战术选择','tactical',96,8)
    transition()
    ending(True)
    ending(False)
