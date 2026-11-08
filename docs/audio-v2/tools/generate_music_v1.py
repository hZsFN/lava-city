"""Original score for Molten Heart / 熔心孤塔.

Deterministic synthesis, no samples, 96 BPM, D minor with Phrygian colour.
All loops have an exact whole-bar length, wrapped note/reverb tails and a shared grid.
Run from any directory: python -B tools/generate_music.py
"""
import numpy as np
from scipy import signal
from common import SR, clock, hz, env, room, write_asset

BPM = 96
BEAT = 60 / BPM
BAR = BEAT * 4
RNG = np.random.default_rng(2026110807)
TAU = 2*np.pi


def place(dst, x, at=0, gain=1, pan=0, loop=False):
    """Stereo constant-power panning and exact sample-aligned circular placement."""
    if x.ndim == 1:
        angle = (pan+1)*np.pi/4
        x = np.column_stack([x*np.cos(angle), x*np.sin(angle)])
    start = round(at*SR)
    if loop:
        start %= len(dst)
        first = min(len(x), len(dst)-start)
        dst[start:start+first] += x[:first]*gain
        if first < len(x):
            remain = x[first:]
            while len(remain):
                count = min(len(remain), len(dst))
                dst[:count] += remain[:count]*gain
                remain = remain[count:]
    else:
        lo, hi = max(0,start), min(len(dst),start+len(x))
        if hi > lo:
            dst[lo:hi] += x[lo-start:hi-start]*gain


def lowpass(x, cutoff, order=2):
    return signal.sosfilt(signal.butter(order,cutoff,fs=SR,output='sos'),x,axis=0)


def soft_string(midi, seconds, attack=.16, release=.4, tension=0):
    """Dark bowed ensemble: harmonic oscillator pairs, slow vibrato, bowed envelope."""
    t=clock(seconds)
    f=hz(midi)
    phase=TAU*f*t + .1*np.sin(TAU*4.7*t)
    x=np.zeros(len(t))
    for k in range(1,8):
        x += np.sin(k*phase + .2*k) / k**1.7
        x += .32*np.sin(k*phase*1.0019 + .7) / k**1.85
    x=lowpass(x, min(3200,1500+tension*900))
    e=np.minimum(1,t/attack)**1.4
    e *= np.minimum(1,np.maximum(0,(seconds-t)/release))**1.8
    e *= .86+.14*np.sin(TAU*.31*t)
    return x*e*.35


def bowed_chord(notes, seconds=12, tension=0):
    out=np.zeros((round(seconds*SR),2))
    for n,(note,pan) in enumerate(zip(notes,np.linspace(-.55,.55,len(notes)))):
        voice=soft_string(note,seconds,1.4,2.2,tension)
        place(out,voice,gain=.7 if n else .85,pan=float(pan))
    return out


def bass(midi, seconds=.5):
    t=clock(seconds)
    f=hz(midi)
    x=(np.sin(TAU*f*t)+.21*np.sin(TAU*2*f*t)+.08*np.sin(TAU*3*f*t))
    return x*env(t,.006,3.2,.06)


def mallet(midi, seconds=1.8, metal=.15):
    t=clock(seconds); f=hz(midi)
    x=np.sin(TAU*f*t + metal*np.sin(TAU*f*2.01*t)*np.exp(-t*3))
    x += .22*np.sin(TAU*f*2.01*t)*np.exp(-t*3)
    x += .065*np.sin(TAU*f*3.98*t)*np.exp(-t*7)
    return x*env(t,.006,2.4,.12)


def drum(kind, intensity=1):
    dur={'low':.85,'mid':.4,'rim':.19,'air':.2,'crash':2.2}[kind]
    t=clock(dur); noise=RNG.normal(0,1,len(t))
    if kind=='low':
        phase=TAU*np.cumsum(48+82*np.exp(-t*22))/SR
        x=np.sin(phase)*np.exp(-t*5.5)
        x+=.25*np.sin(phase*1.48)*np.exp(-t*11)
        x+=.17*lowpass(noise,1400)*np.exp(-t*55)
    elif kind=='mid':
        phase=TAU*np.cumsum(110+140*np.exp(-t*38))/SR
        x=.6*np.sin(phase)*np.exp(-t*12)
        x+=.24*lowpass(noise,3400)*np.exp(-t*20)
        x+=.1*np.sin(TAU*560*t)*np.exp(-t*23)
    elif kind=='rim':
        x=sum(np.sin(TAU*f*t)*a for f,a in [(390,.35),(827,.18),(1397,.06)])*np.exp(-t*42)
        x+=.12*lowpass(noise,4200)*np.exp(-t*60)
    elif kind=='air':
        x=signal.sosfilt(signal.butter(2,[1800,5200],btype='bandpass',fs=SR,output='sos'),noise)*np.exp(-t*29)*.35
    else:
        x=signal.sosfilt(signal.butter(2,[600,4600],btype='bandpass',fs=SR,output='sos'),noise)*np.exp(-t*2.8)*.16
        x+=sum(np.sin(TAU*f*t)*.045 for f in [586,824,1127])*np.exp(-t*2.3)
    return np.tanh(x*1.2)*env(t,.001,0,.045)*intensity


def periodic_bed(duration, level=.08):
    n=round(duration*SR); t=clock(duration)
    bed=np.zeros((n,2))
    # Frequencies lie on the exact loop's FFT bins; no oscillator restart click.
    for f,amp in [(hz(26),.6),(hz(38),.28),(hz(45),.13)]:
        fq=round(f*duration)/duration
        tone=np.sin(TAU*fq*t)*amp
        bed[:,0]+=tone; bed[:,1]+=tone
    for ch in range(2):
        white=RNG.normal(size=n)
        freqs=np.fft.rfftfreq(n,1/SR)
        filt=(1/(1+(freqs/190)**4))*(freqs/(freqs+35))
        rumble=np.fft.irfft(np.fft.rfft(white)*filt,n=n)
        rumble/=np.std(rumble)+1e-12
        bed[:,ch]+=rumble*.14*(.8+.2*np.sin(TAU*t/duration*2+ch*.7))
    return bed*level


def arrange_loop(name, title, bars, mode):
    duration=bars*BAR
    dst=periodic_bed(duration,.095 if mode=='explore' else .06)
    roots=[38,34,43,33]   # D2, Bb1, G2, A1
    chords=[[50,57,62,65],[46,53,58,62],[43,50,58,62],[45,52,58,61]]
    intensity={'explore':0,'boss1':1,'boss2':2,'rage':3}[mode]
    # Four-bar harmonic pillars (two bars in the shorter rage loop).
    span=4 if bars==16 else 2
    for block in range(4):
        ch=chords[block]
        # Exploration ends on a softer A-sus chord; combat uses A7(b9) tension.
        if mode=='explore' and block==3: ch=[45,52,59,62]
        pad=bowed_chord(ch,span*BAR+2.0,tension=intensity*.25)
        place(dst,pad,block*span*BAR-.8,.34 if mode=='explore' else .27,loop=True)
    for bar in range(bars):
        root=roots[bar//span]
        start=bar*BAR
        if mode=='explore':
            # A sparse double pulse, with room for wind, lava and interaction sounds.
            if bar%2==0:
                place(dst,drum('low'),start,.22,loop=True)
                place(dst,drum('low'),start+.30,.09,loop=True)
            if bar%4==2:
                place(dst,drum('rim'),start+BEAT*2,.13,pan=.25,loop=True)
            if bar%2==1:
                place(dst,bass(root,1.2),start,.14,loop=True)
        else:
            kick_pattern=[(0,.65),(1.5,.31),(2.5,.48)]
            if mode in ('boss2','rage'): kick_pattern += [(3.5,.37)]
            for beat,velocity in kick_pattern:
                place(dst,drum('low'),start+beat*BEAT,velocity*.6,loop=True)
            for beat in (1,3):
                place(dst,drum('mid'),start+beat*BEAT,.28 if mode=='boss1' else .35,pan=.12,loop=True)
            for i in range(8):
                if i%2==0 or mode!='boss1':
                    place(dst,drum('air'),start+i*BEAT/2,.13 if i%2==0 else .075,pan=(-1)**i*.35,loop=True)
            for beat in ([.75,2.25] if mode=='boss1' else [.75,1.75,2.25,3.25]):
                place(dst,drum('rim'),start+beat*BEAT,.15,pan=-.3,loop=True)
            for beat in [0,1.5,2,3.5]:
                note=root+(12 if beat==3.5 and bar%2 else 0)
                place(dst,bass(note,.52),start+beat*BEAT,.28,loop=True)
            # Broken string ostinato becomes more dense in phase II.
            steps=[0,1.5,2.5] if mode=='boss1' else [0,.5,1.5,2,2.5,3.5]
            intervals=[12,19,24,19,15,19]
            for j,beat in enumerate(steps):
                voice=soft_string(root+intervals[j],.30 if mode=='rage' else .42,.012,.16,.6)
                place(dst,voice,start+beat*BEAT,.25 if mode=='boss1' else .32,pan=(-1)**j*.27,loop=True)
            if bar%4==3:
                for j,beat in enumerate([2.75,3.25,3.75]):
                    place(dst,drum('mid'),start+beat*BEAT,.13+j*.025,pan=(j-1)*.2,loop=True)
            if bar%4==0:
                place(dst,drum('crash'),start,.35 if mode=='boss1' else .5,pan=-.15,loop=True)
        # The score's own D–A–F–E motif: call, answer, altered return, cadence.
        if bar%4 in (0,2):
            seq=([62,69,65,64] if bar%4==0 else [62,65,63,62])
            if bar//span==1: seq=[62,65,70,69]
            if bar//span==2: seq=[67,69,70,65]
            if bar//span==3: seq=[64,65,61,62]
            if mode=='explore':
                for j,note in enumerate(seq):
                    place(dst,mallet(note,2.5,.15),start+j*BEAT*1.75,.11,pan=(-1)**j*.4,loop=True)
            else:
                for j,note in enumerate(seq):
                    at=start+j*BEAT*.75
                    place(dst,mallet(note+(12 if mode=='rage' else 0),1.8,.35),at,.13 if mode=='boss1' else .15,pan=(-1)**j*.25,loop=True)
                if mode in ('boss2','rage'):
                    long=soft_string(seq[0]+12,BAR*1.5,.25,.6,.5)
                    place(dst,long,start,.1,pan=.08,loop=True)
        if mode=='rage':
            # Two-beat pressure pulses, not a faux game warning alarm.
            for beat in [0,2]:
                place(dst,soft_string(50+bar%2,.7,.015,.25,.8),start+beat*BEAT,.23,pan=-.15,loop=True)
    dst=room(dst,wet=.10 if intensity else .18,wrap=True)
    dst=np.tanh(dst*.85)
    event_phase={'explore':'wake/prep','boss1':'boss1','boss2':'boss2','rage':'rage'}[mode]
    usage=f'MatchPhaseChanged.phase={event_phase}；{bars}小节，96 BPM，D小调；按整拍同步，切换淡化0.8秒。'
    write_asset(name,dst,title,'music',True,usage,['MatchPhaseChanged'],BPM)


def transition():
    d=8.0; t=clock(d); dst=np.zeros((len(t),2))
    # A tonal rupture, a descending rock body, then suspended chords and a rising lift.
    place(dst,drum('low'),0,.72)
    place(dst,drum('crash'),0,.55,pan=-.25)
    for note in [38,50,57,63]:
        place(dst,soft_string(note,5,.4,1.7,.4),0,.28,pan=(note-50)/40)
    noise=RNG.normal(size=len(t))
    wind=signal.sosfilt(signal.butter(2,[300,2800],btype='bandpass',fs=SR,output='sos'),noise)
    sweep=np.sin(TAU*np.cumsum(66+120*(t/d)**2)/SR)
    lift=(wind*.11+sweep*.09)*(np.sin(np.pi*t/d)**2)*(.2+.8*t/d)
    place(dst,lift,gain=.7)
    for j,note in enumerate([62,65,69,74]):
        place(dst,mallet(note,2.2,.28),4+j*.55,.13,pan=(j-1.5)*.16)
    place(dst,drum('low'),6,.43)
    write_asset('bgm-phase-transition',room(dst,.18),'熔壳剥落 · 转阶段','music',False,
                'BossPhaseChanged.to=2 或 MatchPhaseChanged.phase=transition 二选一触发；8秒过门，余下转场由熔岩环境音填充。',
                ['BossPhaseChanged','MatchPhaseChanged'],BPM)


def ending(win):
    d=7.5 if win else 6
    dst=np.zeros((round(d*SR),2))
    if win:
        # D minor to an open D major final colour: relief without a cartoon fanfare.
        for notes,at in [([50,57,62,65],0),([46,53,58,62],1.7),([50,57,62,66],3.2)]:
            seconds=min(4.3,d-at)
            for j,n in enumerate(notes):
                place(dst,soft_string(n,seconds,.2,1.8,.2),at,.28,pan=(j-1.5)*.24)
        for j,n in enumerate([62,65,69,74,78]):
            place(dst,mallet(n,3.2,.2),.25+j*.625,.21,pan=(j-2)*.16)
        place(dst,drum('low'),0,.45)
        place(dst,drum('crash'),3.15,.45)
        name,title='bgm-victory','余烬见光 · 胜利'
    else:
        for j,n in enumerate([62,61,58,50]):
            place(dst,mallet(n,2.8,.24),j*.7,.22,pan=(1.5-j)*.18)
        for j,n in enumerate([38,45,50,53]):
            place(dst,soft_string(n,5.5,.18,2.8,.1),0,.3,pan=(j-1.5)*.2)
        place(dst,drum('low'),0,.45)
        name,title='bgm-defeat','沉入熔海 · 失败'
    dst=room(dst,.17)
    # A full musical decay rather than a hard render cut.
    tail=round(1.6*SR); dst[-tail:]*=np.linspace(1,0,tail)[:,None]**1.5
    write_asset(name,dst,title,'music',False,
                f"MatchEnded.result={'win' if win else 'lose'}；淡出战斗音乐后单次播放，禁止循环。",['MatchEnded'],BPM)


if __name__=='__main__':
    arrange_loop('bgm-molten-heart','渊火回声 · 探索与布防',16,'explore')
    arrange_loop('bgm-boss-phase1','岩甲之重 · 第一阶段',16,'boss1')
    arrange_loop('bgm-boss-phase2','熔心燃尽 · 第二阶段',16,'boss2')
    arrange_loop('bgm-rage','最后余烬 · 狂暴',8,'rage')
    transition()
    ending(True)
    ending(False)
