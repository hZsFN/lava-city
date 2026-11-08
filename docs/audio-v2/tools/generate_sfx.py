"""Deterministic, sample-free sound design for Molten Heart.

Run: python -B tools/generate_sfx.py
All waveforms are synthesized from filtered noise, modal resonances and oscillators.
Each sound gets its own seeded random stream, so ordering does not change renders.
"""
import hashlib
import numpy as np
from scipy import signal
from common import SR, clock, hz, env, put, room, write_asset


def rng_for(name):
    return np.random.default_rng(int.from_bytes(hashlib.sha256(name.encode()).digest()[:8], 'little'))


def noise(t, rng, low=80, high=6000):
    sos = signal.butter(3, [low, high], btype='bandpass', fs=SR, output='sos')
    x = signal.sosfilt(sos, rng.normal(size=len(t)))
    return x / max(np.sqrt(np.mean(x*x)), 1e-9)


def sweep(t, f0, f1, speed=10, decay=8, attack=.002):
    f = f1+(f0-f1)*np.exp(-t*speed)
    return np.sin(2*np.pi*np.cumsum(f)/SR)*env(t, attack, decay)


def modal(t, root=180, decay=6, bright=.45, attack=.0015):
    x = np.zeros_like(t)
    for i, ratio in enumerate([1, 1.47, 2.09, 2.83, 4.17, 5.43, 7.11]):
        f = root*ratio
        if f > 11000: continue
        x += np.sin(2*np.pi*f*t + .11*i) * (bright**i) * env(t, attack, decay*(1+i*.3))
    return x


def grit(t, rng, density=22, low=500, high=8500, power=.25):
    x = np.zeros_like(t)
    for _ in range(max(1, int(t[-1]*density))):
        at = rng.uniform(0, max(.001,t[-1]-.04))
        tt = clock(rng.uniform(.012,.055))
        g = noise(tt,rng,low,high)*env(tt,.0007,rng.uniform(55,130),.006)
        put(x,g,at,gain=power*rng.uniform(.4,1)*np.exp(-at*2.2))
    return x


def emit(name, title, dur, fn, usage, events=None, category='sfx', loop=False):
    t = clock(dur); rng = rng_for(name)
    x = fn(t,rng)
    write_asset(name,x,title,category,loop,usage,events)


def stone_impact(t, rng, weight=1):
    x = .65*sweep(t,155*weight,38*weight,22,3.8)
    x += .22*noise(t,rng,110,2200)*env(t,.0008,17)
    x += .10*modal(t,143*weight,8,.45)
    x += grit(t,rng,30,280,6700,.045)
    return room(x,.07)


def glass(t, rng, root=500, decay=6):
    x=.55*modal(t,root,decay,.69,.003)
    x+=.10*noise(t,rng,1400,9000)*env(t,.004,22)
    return room(x,.15)


def physical(t,rng,variant=0):
    x=.56*sweep(t,350+variant*30,92,42,18)
    x+=.18*noise(t,rng,700,6500)*env(t,.0004,53)
    x+=.24*modal(t,260+variant*19,25,.48)
    tt=clock(.09)
    put(x,modal(tt,550+variant*30,36,.4),.055,.10)
    return x


def arcane(t,rng,variant=0):
    f=380+variant*18
    x=.45*sweep(t,f*1.8,f*.7,13,6,.006)
    x+=.21*np.sin(2*np.pi*f*t+1.7*np.sin(2*np.pi*f*1.501*t))*env(t,.008,8)
    x+=.12*noise(t,rng,1500,7500)*env(t,.015,15)
    return room(x,.13)


def execution(t,rng):
    x=stone_impact(t,rng,.8)*.7
    x+=.22*noise(t,rng,900,6500)*env(t,.0005,23)
    for start,root,level in [(0,146.83,.28),(.028,293.66,.17),(.065,440,.12)]:
        tt=clock(max(.01,t[-1]-start))
        put(x,modal(tt,root,2.8,.64),start,level)
    x+=grit(t,rng,35,600,9500,.065)
    return room(x,.19)


def weakness_open(t,rng):
    f=300+520*(1-np.exp(-t*5))
    x=np.sin(2*np.pi*np.cumsum(f)/SR)*env(t,.025,4)*.35
    for start,note in [(0,74),(.075,81),(.15,86)]:
        tt=clock(max(.01,t[-1]-start))
        put(x,modal(tt,hz(note),4.5,.62),start,.32)
    x+=noise(t,rng,1400,7000)*env(t,.06,11)*.06
    return room(x,.17)


def tower_build(t,rng):
    x=stone_impact(t,rng,1.2)*.65
    for at,f in [(.08,293.66),(.18,440),(.29,587.33)]:
        tt=clock(max(.01,t[-1]-at)); put(x,modal(tt,f,8,.5),at,.18)
    return room(x,.1)


def rune_sequence(t,rng,notes,interval=.065):
    x=np.zeros_like(t)
    for i,n in enumerate(notes):
        at=i*interval; tt=clock(max(.01,t[-1]-at))
        put(x,modal(tt,hz(n),8,.52),at,.45)
    x+=noise(t,rng,1200,6000)*env(t,.002,45)*.035
    return room(x,.1)


def fire(t,rng,breath=False):
    duration=t[-1]
    if breath:
        shape=(1-np.exp(-t*6))*np.minimum(1,(duration-t)*2.2)
        turbulent=.68+.19*np.sin(2*np.pi*6.2*t)+.10*np.sin(2*np.pi*13.7*t)
        x=noise(t,rng,90,4500)*shape*turbulent*.24
        x+=np.sin(2*np.pi*57*t+1.8*np.sin(2*np.pi*9*t))*shape*.18
        x+=grit(t,rng,45,1000,9500,.055)
    else:
        x=noise(t,rng,75,3800)*env(t,.018,3)*.34
        x+=sweep(t,160,42,9,4,.02)*.38
        x+=grit(t,rng,50,1200,8500,.06)
    return room(x,.1)


def warning(t,rng):
    x=np.zeros_like(t)
    for at in [0,.30,.60]:
        tt=clock(min(.4,t[-1]-at))
        p=.5*modal(tt,293.66,12,.35)+.3*modal(tt,311.13,13,.25)
        p+=noise(tt,rng,600,2400)*env(tt,.005,25)*.04
        put(x,p,at,.7)
    return x


def periodic_noise(n,rng,low,high):
    f=np.fft.rfftfreq(n,1/SR)
    weight=np.exp(-(f/high)**4) * (1-np.exp(-(f/low)**4))
    weight[0]=0
    spec=(rng.normal(size=len(f))+1j*rng.normal(size=len(f)))*weight
    x=np.fft.irfft(spec,n)
    return x/max(np.std(x),1e-9)


def lava_loop(t,rng,violent=False):
    duration=len(t)/SR
    n=len(t)
    out=np.zeros((n,2))
    # FFT-shaped noise and integer-cycle modulation are periodic over exact duration.
    for c in range(2):
        rumble=periodic_noise(n,rng,32,170 if violent else 120)
        air=periodic_noise(n,rng,330,1900)
        shape=.70+.16*np.sin(2*np.pi*2*t/duration+c*.4)+.07*np.sin(2*np.pi*5*t/duration)
        out[:,c]=rumble*shape*.32+air*.028
        f=round(47*duration)/duration
        out[:,c]+=.075*np.sin(2*np.pi*f*t+.2*c)*(1+.3*np.sin(2*np.pi*t/duration))
    for i in range(19 if violent else 26):
        at=rng.uniform(0,duration); tt=clock(rng.uniform(.20,.48))
        bubble=sweep(tt,rng.uniform(90,170),rng.uniform(35,65),7,11,.008)
        bubble+=noise(tt,rng,300,2100)*env(tt,.02,20)*.12
        put(out,bubble,at,gain=rng.uniform(.025,.055),pan=rng.uniform(-.8,.8),wrap=True)
    return room(out,.12,wrap=True)


def tower_loop(t,rng):
    duration=len(t)/SR; n=len(t)
    out=np.zeros((n,2))
    for c in range(2):
        out[:,c]=.13*periodic_noise(n,rng,130,1300)*(.7+.2*np.sin(2*np.pi*2*t/duration+c*.8))
        for f,g in [(73.416,.12),(110,.055),(146.83,.045)]:
            ff=round(f*duration)/duration
            out[:,c]+=g*np.sin(2*np.pi*ff*t+c*.16)*(.8+.18*np.sin(2*np.pi*t/duration+c))
    for at,note,pan in [(1.5,62,-.6),(7.2,69,.5),(13.1,74,-.15)]:
        tt=clock(4); chime=modal(tt,hz(note),1.9,.58,.012)
        put(out,chime,at,.035,pan,wrap=True)
    return room(out,.21,wrap=True)


def main():
    emit('sfx-execution','熔核击破',2.4,execution,'击破伤害结算落点；仅 ExecutionEnded 播一次，避免开始/结束重复。',['ExecutionEnded'])
    emit('sfx-weakness-open','弱点显露',1.4,weakness_open,'弱点窗口开启提示；不同部位并发时合并提示。',['WeaknessExposed'])
    emit('sfx-hit','岩刃受击',.30,lambda t,r:.5*sweep(t,240,65,42,20)+.16*noise(t,r,140,2600)*env(t,.001,35),'玩家实际受伤反馈，建议80ms限流。',['PlayerDamaged'])
    emit('sfx-lava-rise','熔岩上涨',8,lambda t,r:lava_loop(t,r,True),'上涨状态进入时开启循环，停止上涨时淡出；不可每帧重播。',['LavaLevelChanged'],category='ambience',loop=True)
    for variant in range(2):
        suffix='ab'[variant]
        emit(f'sfx-physical-shot-{suffix}',f'物理弩击 {suffix.upper()}',.24,lambda t,r,v=variant:physical(t,r,v),'玩家物理发射变体；当前契约没有发射事件，需要武器实际开火处调用。',[])
        emit(f'sfx-arcane-shot-{suffix}',f'符文射击 {suffix.upper()}',.52,lambda t,r,v=variant:arcane(t,r,v),'玩家法术发射变体；当前契约没有发射事件，需要武器实际开火处调用。',[])
    emit('sfx-dash','疾步破风',.40,lambda t,r:noise(t,r,350,4900)*np.sin(np.pi*t/.4)**2*np.exp(-t*3)*.35+sweep(t,260,70,11,8,.012)*.16,'冲刺起步，当前位置跟随玩家。',['PlayerDashed'])
    emit('sfx-form-switch','双形态转换',.66,lambda t,r:rune_sequence(t,r,[62,69,74],.07)+noise(t,r,450,3800)*env(t,.045,12)*.09,'形态切换确认；物理与法术可分别配不同播放速率。',['FormSwitched'])
    emit('sfx-overheat','过热泄压',1.05,lambda t,r:noise(t,r,950,6500)*env(t,.003,3)*(.3+.08*np.sin(2*np.pi*28*t))+.22*modal(t,220,9,.35),'仅 overheated 从 false 变 true 时播放。',['OverheatChanged'])
    emit('sfx-tower-build','石基建造',1.05,tower_build,'防御塔成功放置。',['TowerPlaced'])
    emit('sfx-tower-upgrade','符文升阶',1.10,lambda t,r:rune_sequence(t,r,[62,65,69,74],.085)+stone_impact(t,r,1.4)*.18,'升级成功确认。',['TowerUpgraded'])
    emit('sfx-tower-sell','熔核回收',.70,lambda t,r:rune_sequence(t,r,[74,69,62],.09),'只在 reason=sold 时播放。',['TowerDestroyed'])
    emit('sfx-tower-destroy','石塔崩解',1.55,lambda t,r:stone_impact(t,r,.85)+grit(t,r,55,120,5200,.11),'只在 reason=broken 或 drowned 时播放；与回收声互斥。',['TowerDestroyed'])
    emit('sfx-tower-ballista','弩炮命中',.36,lambda t,r:physical(t,r,0)*.75+modal(t,175,12,.5)*.30,'TowerTargetHit 且 kind=ballista；作为命中声使用。',['TowerTargetHit'])
    emit('sfx-tower-rune','符文灼印',.62,lambda t,r:arcane(t,r,1)*.70+modal(t,587.33,8,.58)*.23,'TowerTargetHit 且 kind=rune；作为命中声使用。',['TowerTargetHit'])
    emit('sfx-tower-frost','寒晶蓄能',.72,lambda t,r:glass(t,r,880,7)*.5+noise(t,r,2000,9000)*env(t,.055,15)*.08,'冻结进度跨25/50/75%阈值时可提示；应限流，不随每次进度更新播放。',['FreezeProgressChanged'])
    emit('sfx-tower-quake','震地锚脉冲',.82,lambda t,r:stone_impact(t,r,.7)*.9+modal(t,92,7,.55)*.3,'震地塔请求打断的出手音；成功打断反馈需另按 BossSkillInterrupted 过滤。',['TowerInterruptRequested'])
    emit('sfx-tower-totem','嘲讽共鸣',1.2,lambda t,r:modal(t,110,3,.72)*.55+modal(t,146.83,4,.63)*.24+noise(t,r,300,1800)*env(t,.03,7)*.07,'嘲讽生效时播放，单次，不持续叠加。',['TauntStarted'])
    emit('sfx-boss-windup','岩甲蓄势',1.20,lambda t,r:noise(t,r,120,4200)*np.sin(np.pi*t/1.2)**2*.23+modal(t,82.4,1.9,.72,.08)*.42,'BossSkillStart 且 stage=windup；通用预警，不冒充精确前摇长度。',['BossSkillStart'])
    emit('sfx-boss-slam','巨掌砸落',1.75,lambda t,r:stone_impact(t,r,.65)+noise(t,r,50,700)*env(t,.007,3.7)*.14,'BossSkillStart stage=active 且技能为砸击；具体skill映射见接入说明。',['BossSkillStart'])
    emit('sfx-boss-fire','熔火爆裂',1.60,lambda t,r:fire(t,r,False),'火弹或火雨单次落点；技能级可在 active 使用，逐落点需新增调用点。',['BossSkillStart'])
    emit('sfx-boss-breath','熔息喷涌',2.60,lambda t,r:fire(t,r,True),'喷息技能 active；非循环，可按实际技能结束淡出，不适合无限repeat。',['BossSkillStart'])
    emit('sfx-freeze','寒晶封冻',1.30,lambda t,r:glass(t,r,740,4)+grit(t,r,45,1700,10000,.055),'完全冻结确认；可在 BossSkillInterrupted by=freeze 时与 FreezeFull 去重。',['FreezeFull'])
    emit('sfx-core-warning','塔心濒危',1.10,warning,'塔心血量首次跌破25%时提示，建议最多每4秒一次。',['CoreHpChanged'])
    emit('sfx-ui-confirm','符印确认',.22,lambda t,r:rune_sequence(t,r,[74,81],.04),'菜单确认；当前契约无专用UI事件，需UI按钮调用。',[],category='ui')
    emit('sfx-ui-cancel','符印取消',.22,lambda t,r:rune_sequence(t,r,[69,62],.04),'菜单取消；当前契约无专用UI事件，需UI按钮调用。',[],category='ui')
    emit('sfx-player-death','余烬熄灭',2.00,lambda t,r:sweep(t,180,35,1.9,1.8,.035)*.4+noise(t,r,180,3000)*env(t,.02,2.5)*.18+modal(t,146.83,2.5,.45)*.17,'玩家死亡，仅一次；复活后恢复常规混音。',['PlayerDied'])
    emit('sfx-weakness-close','弱点收束',.65,lambda t,r:rune_sequence(t,r,[81,74,62],.065)*.65+noise(t,r,500,3400)*env(t,.035,9)*.10,'弱点关闭；击破成功同帧可抑制此声，避免覆盖击破。',['WeaknessClosed'])
    emit('amb-lava','熔岩海低鸣',16,lambda t,r:lava_loop(t,r,False),'通用熔岩环境床，开局淡入；与上涨层分别控制音量。',['MatchPhaseChanged'],category='ambience',loop=True)
    emit('amb-tower','孤塔风与符文',16,tower_loop,'塔顶环境床，开局淡入；可与熔岩海低鸣低音量叠加。',['MatchPhaseChanged'],category='ambience',loop=True)


if __name__ == '__main__':
    main()
