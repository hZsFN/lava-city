"""Molten Heart V2.1: original epic-trailer style battle score (no external melody, samples or audio).

Rhythmic identity: 16th grid with 3+3+2 accents (beats 0, .75, 1.5 | 2, 2.75, 3.5), kick-ducked
tonal bus for a clear pulse, taiko/anvil forge hits, strings spiccato, low brass stabs, choir and an
original brass theme. Lava colour: braams, sub booms, magma bubbles and rising hiss.
Overwrites bgm-boss-phase1 / bgm-boss-phase2 / bgm-rage raw+metadata produced by generate_music.py.
Run after generate_music.py: python -B tools/generate_battle_epic.py
"""
import numpy as np
from common import SR, clock, hz
from generate_music import TAU, seed, place, filt, voice, drum, chord, periodic_bed, master_bus, save

ACCENTS=[0,.75,1.5,2,2.75,3.5]

CH={'Dm':(38,[50,57,62,65]),'Bb':(34,[46,53,58,62]),'Gm':(43,[43,50,58,62]),'A':(33,[45,52,57,61]),
    'F':(41,[53,57,60,65]),'C':(36,[48,55,60,64]),'Eb':(39,[51,58,63,67])}

THEME1=[[(0,62,1.5),(1.5,65,.5),(2,69,1.5),(3.5,67,.5)],
        [(0,65,1),(1,70,1),(2,69,2)],
        [(0,67,.75),(.75,65,.75),(1.5,67,.5),(2,70,1.5),(3.5,69,.5)],
        [(0,64,2),(2,61,1),(3,64,1)],
        [(0,74,1.5),(1.5,72,.5),(2,69,1.5),(3.5,72,.5)],
        [(0,72,1),(1,77,1),(2,76,1.5),(3.5,74,.5)],
        [(0,72,.75),(.75,74,.75),(1.5,76,.5),(2,79,2)],
        [(0,76,1.5),(1.5,73,.5),(2,69,2)]]
PROG1=['Dm','Bb','Gm','A','Dm','F','C','A']

# Phase II: phrygian Eb colour, the same motif pushed harder.
THEME2=[[(0,62,.75),(.75,65,.75),(1.5,69,.5),(2,74,1.5),(3.5,72,.5)],
        [(0,70,1),(1,67,1),(2,75,2)],
        [(0,74,.75),(.75,72,.75),(1.5,70,.5),(2,69,1.5),(3.5,70,.5)],
        [(0,69,2),(2,73,1),(3,76,1)],
        [(0,74,1.5),(1.5,77,.5),(2,81,1.5),(3.5,79,.5)],
        [(0,79,1),(1,75,1),(2,74,1.5),(3.5,75,.5)],
        [(0,77,.75),(.75,74,.75),(1.5,70,.5),(2,72,2)],
        [(0,73,1.5),(1.5,76,.5),(2,81,2)]]
PROG2=['Dm','Eb','Bb','A','Dm','Eb','F','A']

def anvil(variant=0):
    t=clock(.9);rng=seed(f'anvil-{variant}');f0=880*(1+.03*variant)
    x=sum(a*np.sin(TAU*f0*r*t)*np.exp(-t*d) for r,a,d in [(1,1,7),(2.76,.55,11),(5.40,.3,16),(8.93,.16,24)])
    x+=filt(rng.normal(size=len(t)),[2000,9000],'bandpass')*np.exp(-t*90)*.8
    return np.tanh(x*.9)*.5

def braam(note,d=2.4):
    x=sum(voice('horn',n,d) for n in (note,note+7,note+12))
    x=np.tanh(x*3.2)
    t=clock(len(x)/SR);open_=np.clip(t/.35,0,1)*np.exp(-t*1.3)
    x=filt(x,380)*(1-open_)+filt(x,2600)*open_
    boom=np.sin(TAU*np.cumsum(30+28*np.exp(-t*4))/SR)*np.exp(-t*1.6)*1.4
    return (x+boom)*np.minimum(1,(d+.2-t)/.4).clip(0,1)

def riser(d,rng):
    t=clock(d);ramp=(t/d)**2.2
    x=filt(rng.normal(size=len(t)),[600,7000],'bandpass')*ramp*.5
    x+=np.sin(TAU*np.cumsum(110+700*ramp)/SR)*ramp*.12
    return x

def bubbles(dst,seconds,rng,count,level):
    for _ in range(count):
        q=clock(rng.uniform(.12,.3));f0=rng.uniform(60,160)
        b=np.sin(TAU*np.cumsum(f0*(1+2.2*q/q[-1]))/SR)*np.exp(-q*14)
        place(dst,filt(b,900),rng.uniform(0,seconds),level*rng.uniform(.4,1),pan=rng.uniform(-.6,.6),wrap=True)

def duck_env(n,times,depth=.32,release=.16):
    k=clock(.3);kernel=np.exp(-k/release)*np.minimum(1,k/.004+.001)
    acc=np.zeros(n)
    for at in times:
        idx=(np.arange(len(kernel))+round(at*SR))%n
        np.add.at(acc,idx,kernel)
    return (1-depth*np.minimum(1,acc))[:,None]

def epic(name,title,mode,bpm,bars,prog,theme):
    beat=60/bpm;barlen=4*beat;dur=bars*barlen;n=round(dur*SR);rng=seed(name+'-epic')
    perc=np.zeros((n,2));tone=np.zeros((n,2));kicks=[]
    rage=mode=='rage';p2=mode=='boss2'
    lava=periodic_bed(dur,seed(name),.05 if not rage else .04)
    bubbles(lava,dur,rng,bars*2,.05)
    def section(bar):
        if rage:return 'climax' if bar>=bars//2 else 'theme'
        return ['intro']*4+['drive']*8+['theme']*8+['break']*4+['climax']*8
    secs=section(0) if not rage else None
    for bar in range(bars):
        s=secs[bar] if secs else section(bar)
        at=bar*barlen;cname=prog[bar%8];root,c=CH[cname];big=s in ('theme','climax')
        # ── percussion: the 3+3+2 accent grid is the track's rhythmic signature ──
        if s=='break':
            for pos,v in [(0,.9),(2,.7)]:
                place(perc,drum('taiko',bar%3),at+pos*beat,.42*v,pan=-.15,wrap=True)
                place(perc,drum('kick',0),at+pos*beat,.5*v,wrap=True);kicks.append(at+pos*beat)
            if bar%4==3:
                for j in range(16):
                    place(perc,drum('snare',j%2),at+j*.25*beat,.05+.012*j,pan=-.05,wrap=True)
        else:
            for i,pos in enumerate(ACCENTS):
                v=1 if i in (0,3) else .72
                place(perc,drum('kick',i%3),at+pos*beat,.55*v,wrap=True);kicks.append(at+pos*beat)
                place(perc,drum('taiko',(bar+i)%3),at+(pos+.01)*beat,(.34 if big else .28)*v,pan=(-.3,.3)[i%2],wrap=True)
            if s!='intro' or p2:
                for pos in (1,3):place(perc,drum('snare',bar%2),at+pos*beat,.36 if big else .3,pan=.03,wrap=True)
            if big or rage:
                for pos in (1,3):place(perc,anvil(bar%3),at+(pos+.5)*beat,.16 if not rage else .19,pan=.35,wrap=True)
            if s=='climax' or (p2 and s=='theme'):
                for j in range(16):
                    place(perc,drum('hat',j%2),at+j*.25*beat,.11 if j%4==0 else .055,pan=(-1)**j*.4,wrap=True)
            if rage:
                for pos in (.25,2.25):place(perc,drum('kick',2),at+pos*beat,.3,wrap=True)
        if bar%4==0 and s!='intro':place(perc,drum('crash'),at,.4 if big else .28,pan=.1,wrap=True)
        if bar%8==7 or bar==bars-1:
            for j,pos in enumerate([2,2.5,2.75,3,3.25,3.5,3.75]):
                place(perc,drum('tom',j%3),at+pos*beat,.14+.03*j,pan=(j-3)*.12,wrap=True)
        # ── lava colour: braam on section entries, riser into them ──
        if (secs and bar in (0,20)) or (rage and bar==0) or (p2 and bar==12):
            place(tone,braam(root+12 if root<36 else root),at,.30,wrap=True)
        if (secs and bar in (3,11,23)) or (rage and bar==bars-1):
            place(perc,riser(barlen,rng),at,.5,pan=.05,wrap=True)
        # ── tonal bus ──
        if s=='intro':
            chord(tone,[x+12 for x in c[1:]],at,barlen,.05,'choir',True)
            if p2:
                for j in range(16):
                    place(tone,voice('strings',c[[0,3,1,3][j%4]]+12,.07),at+j*.25*beat,.13 if j*.25 in ACCENTS else .06,pan=(-1)**j*.3,wrap=True)
            continue
        if s=='break':
            chord(tone,c,at,barlen,.12,'strings',True)
            chord(tone,[x+12 for x in c[1:]],at,barlen,.11,'choir',True)
            place(tone,voice('bass',root,barlen*.9),at,.32,wrap=True)
            seq=theme[bar%8][:2]
            for pos,note,length in seq:place(tone,voice('horn',note-12,round(length*beat,5)),at+pos*beat,.2,pan=-.08,wrap=True)
            continue
        chord(tone,[x+12 for x in c[1:]],at,barlen,.07 if not big else .09,'choir',True)
        pat=[0,3,1,3,2,3,1,3]
        for j in range(16):
            pos=j*.25;acc=pos in ACCENTS;note=c[pat[j%8]]+12
            place(tone,voice('strings',note,.07),at+pos*beat,.2 if acc else .085,pan=(-1)**j*.3,wrap=True)
            if big and (p2 or rage or s=='climax'):
                place(tone,voice('strings',note+12,.06),at+(pos+.01)*beat,.08 if acc else .035,pan=(-1)**(j+1)*.38,wrap=True)
        for i,pos in enumerate(ACCENTS):
            place(tone,voice('bass',root+(12 if i in (2,5) else 0),.13),at+pos*beat,.42,wrap=True)
            if i<3 or s=='climax':
                for iv in (12,19):place(tone,voice('horn',root+iv,.14),at+pos*beat,.11,pan=(-.2,.2)[iv==19],wrap=True)
        if big:
            up=12 if (s=='climax' and not rage) or (rage and bar>=bars//2) else 0
            for pos,note,length in theme[bar%8]:
                h=round(length*beat*.95,5)
                place(tone,voice('horn',note+up,h),at+pos*beat,.26,pan=-.06,wrap=True)
                place(tone,voice('horn',note+up-12,h),at+(pos+.02)*beat,.14,pan=.12,wrap=True)
                if s=='climax' or rage:place(tone,voice('choir',note+up,h),at+pos*beat,.07,pan=.2,wrap=True)
    tone*=duck_env(n,kicks,.30 if not rage else .36)
    # Section dynamics: quiet intro, building drive, full climax; smoothed so bar edges don't click.
    level={'intro':(.45,.75),'drive':(.72,.9),'theme':(.9,1),'break':(.62,.55),'climax':(1.05,1.08)}
    gt=np.zeros(n);gp=np.zeros(n)
    for bar in range(bars):
        a,b=round(bar*barlen*SR),round((bar+1)*barlen*SR)
        gt[a:b],gp[a:b]=level[secs[bar] if secs else section(bar)]
    k=np.hanning(round(.08*SR));k/=k.sum()
    smooth=lambda g:np.convolve(np.r_[g[-len(k):],g,g[:len(k)]],k,'same')[len(k):-len(k)][:,None]
    x=perc*1.3*smooth(gp)+tone*smooth(gt)+lava*(.6+.4*smooth(gt)**-1).clip(.6,1.4)*.8
    x=master_bus(x,.06,True)
    x/=np.max(np.abs(x));x=np.tanh(x*1.1)/np.tanh(1.1)
    sections=([{'bars':'1–8','role':'全编制主题，3+3+2 重音'},{'bars':'9–16','role':'主题高八度，16分镲与双踩'}] if rage else
              [{'bars':'1–4','role':'braam 落地 + 太鼓重音型'},{'bars':'5–12','role':'弦乐断奏、低铜切分刺音、合唱铺底'},
               {'bars':'13–20','role':'原创铜管主题 + 铁砧锻打'},{'bars':'21–24','role':'半速留白、合唱与低号动机、军鼓滚奏蓄力'},
               {'bars':'25–32','role':'主题高八度高潮、全编制，鼓过门回到开头'}])
    save(name,x,title,True,f'MatchPhaseChanged.phase={mode}；{bpm} BPM、{bars}小节循环，事件驱动切换；不同节奏曲目采用0.8–1.2秒淡化。',
         ['MatchPhaseChanged'],bpm,sections,
         ['史诗预告片风格的原创重写：不含任何外部旋律、和声进行或采样',
          '3+3+2 十六分重音型统一底鼓/太鼓/低音/弦乐，节奏更鲜明',
          '底鼓侧链压低和声层，混响减少以突出节拍',
          '熔岩色彩：braam 低铜轰鸣、次低频冲击、岩浆气泡与上升嘶声、铁砧锻打'])

if __name__=='__main__':
    epic('bgm-boss-phase1','岩甲之重 · 熔炉战歌','boss1',150,32,PROG1,THEME1)
    epic('bgm-boss-phase2','熔心燃尽 · 烈焰战歌','boss2',150,32,PROG2,THEME2)
    epic('bgm-rage','最后余烬 · 熔岩狂潮','rage',160,16,['Dm','Eb','Dm','Eb','Bb','C','A','A'],THEME2)
