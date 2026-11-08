"""V2 gap-filling sound design, based on the 2026-11-08 project audit.

Only creates the 26 new asset IDs listed below. Does not render or replace v1 assets.
Run: python -B tools/generate_additional_sfx.py
"""
import json
import numpy as np
from common import ROOT, SR, clock, hz, env, put, room, write_asset
from generate_sfx import rng_for, noise, sweep, modal, grit, periodic_noise, stone_impact, rune_sequence

TAU=2*np.pi

def render(name,title,duration,fn,usage,events=(),status='needs_action_hook',evidence='',category='sfx',loop=False,mix_gain_db=0):
    t=clock(duration); rng=rng_for('v2/'+name); x=fn(t,rng)
    if not loop:
        # Reserve an audible decay plus a quiet tail before the codec boundary.
        n=min(round(.10*SR),len(x)//3); quiet=min(round(.04*SR),n//2)
        shape=np.r_[np.linspace(1,0,n-quiet)**2,np.zeros(quiet)]
        if x.ndim==2: shape=shape[:,None]
        x[-n:]*=shape
    write_asset(name,x,title,category,loop,usage,list(events))
    path=ROOT/'metadata'/f'{name}.json'
    meta=json.loads(path.read_text(encoding='utf-8'))
    meta.update(introduced_version='v2',implementation_status=status,evidence=evidence,
                suggested_mix_gain_db=mix_gain_db,
                source_method='Deterministic procedural synthesis; no third-party samples',
                integration_tested=False)
    path.write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding='utf-8')

def step(t,rng,variant=0,heavy=False):
    # Close boot-on-basalt: heel mass, sole slap, then a brief gritty toe movement.
    root=[97,111,88,104][variant%4]
    x=sweep(t,root*1.6,root*.6,36,29 if not heavy else 17)*.48
    x+=noise(t,rng,180,1500)*env(t,.001,47)*.13
    x+=noise(t,rng,1200,5100)*env(t,.0015,65)*.09
    at=.038+variant*.005; tt=clock(.14)
    toe=noise(tt,rng,500,3900)*env(tt,.009,35)*.07
    put(x,toe,at)
    x+=grit(t,rng,18,450,4500,.022)
    return room(x,.025)

def jump(t,rng):
    x=step(t,rng,1)*.34
    x+=noise(t,rng,450,3500)*np.sin(np.pi*np.minimum(t/.32,1))**2*np.exp(-t*5)*.10
    x+=sweep(t,95,210,8,12,.02)*.10
    return x

def landing(t,rng,heavy):
    x=step(t,rng,2,True)*(.8 if heavy else .65)
    tt=clock(.32)
    put(x,step(tt,rng,3,True),.035 if heavy else .018,.45)
    x+=noise(t,rng,60,800)*env(t,.002,12 if heavy else 23)*(.16 if heavy else .08)
    if heavy:
        x+=grit(t,rng,32,300,4800,.055)
        x+=modal(t,145,10,.35)*.10
    return room(x,.055 if heavy else .025)

def lava_fall(t,rng):
    d=t[-1]; x=noise(t,rng,450,3800)*env(t,.005,8)*.10
    tt=clock(d-.14)
    impact=stone_impact(tt,rng,.8)*.40
    impact+=noise(tt,rng,450,6500)*env(tt,.035,2.9)*.17
    put(x,impact,.14)
    for at,root in [(.23,165),(.39,120),(.72,145),(1.03,90)]:
        q=clock(.32); put(x,sweep(q,root,root*.36,12,13,.008),at,.14)
    return room(x,.08)

def low_health(t,rng):
    # A dry, double heartbeat and brittle low resonance distinguish player HP from tower alarm.
    x=np.zeros_like(t)
    for at,weight in [(0,.75),(.18,.40),(.64,.66),(.82,.34)]:
        q=clock(.32)
        beat=sweep(q,130,48,30,11,.003)*.60+noise(q,rng,150,1100)*env(q,.002,28)*.035
        put(x,beat,at,weight)
    x+=modal(t,146.83,3.8,.34,.012)*.10
    return x

def mote_gain(t,rng):
    x=rune_sequence(t,rng,[74,81,86],.044)*.52
    x+=noise(t,rng,2600,7700)*env(t,.006,37)*.055
    return room(x,.07)

def execution_ready(t,rng):
    x=np.zeros_like(t)
    for at,n,g in [(0,74,.32),(.09,81,.24),(.19,86,.30)]:
        q=clock(max(.01,t[-1]-at))
        voice=modal(q,hz(n),7,.45,.002)
        voice+=noise(q,rng,1600,5600)*env(q,.002,42)*.045
        put(x,voice,at,g)
    x+=sweep(t,150,73,28,18)*.19
    return room(x,.10)

def execution_windup(t,rng):
    shape=np.sin(np.pi*np.minimum(t/.8,1))**1.8
    x=noise(t,rng,170,2900)*shape*.20
    phase=TAU*np.cumsum(90+310*(t/.9)**1.7)/SR
    x+=np.sin(phase)*shape*.13
    q=clock(.28)
    put(x,noise(q,rng,500,6200)*env(q,.015,16),.52,.10)
    return room(x,.06)

def interrupted(t,rng):
    x=noise(t,rng,650,5500)*env(t,.001,34)*.18
    x+=sweep(t,270,65,13,6)*.37
    x+=modal(t,220,4.8,.56)*.25
    q=clock(.40); put(x,modal(q,146.83,9,.63),.12,.20)
    x+=grit(t,rng,25,500,6200,.045)
    return room(x,.10)

def drain_loop(t,rng):
    duration=len(t)/SR; x=np.zeros((len(t),2))
    for ch in range(2):
        body=periodic_noise(len(t),rng,45,550)
        hiss=periodic_noise(len(t),rng,600,2300)
        pump=.60+.24*np.sin(TAU*6*t/duration+ch*.28)+.12*np.sin(TAU*13*t/duration)
        x[:,ch]=body*pump*.16+hiss*(.65+.3*np.sin(TAU*3*t/duration+ch*.4))*.036
        for f,amp in [(55,.10),(73.416,.08),(110,.055)]:
            ff=round(f*duration)/duration
            x[:,ch]+=np.sin(TAU*ff*t+.025*ch)*(1+.2*np.sin(TAU*8*t/duration))*amp
    for at in [.4,2.0,4.1,6.4]:
        q=clock(1.1); pull=sweep(q,210,70,2.8,3,.13)*.035
        put(x,pull,at,pan=rng.uniform(-.45,.45),wrap=True)
    return room(x,.12,wrap=True)

def rock_sweep(t,rng):
    sh=np.sin(np.pi*np.minimum(t/.7,1))**2
    x=noise(t,rng,120,2500)*sh*.22
    x+=noise(t,rng,1100,5500)*sh*.065
    x+=sweep(t,135,55,8,7,.03)*.16
    q=clock(.40); put(x,modal(q,190,11,.49),.33,.13)
    x+=grit(t,rng,32,280,4600,.04)
    return room(x,.07)

def stone_pillar(t,rng):
    x=np.zeros_like(t)
    for at,weight in [(0,.65),(.14,.36),(.37,.30)]:
        q=clock(max(.01,t[-1]-at)); put(x,stone_impact(q,rng,.75),at,weight)
    x+=noise(t,rng,80,1700)*env(t,.09,4.5)*.13
    x+=grit(t,rng,60,170,5400,.075)
    return room(x,.12)

def lava_charge(t,rng):
    sh=np.sin(np.pi*np.minimum(t/.85,1))**1.5
    x=noise(t,rng,70,1900)*sh*.20
    x+=noise(t,rng,1000,6500)*sh*.045
    x+=sweep(t,170,50,3,2.5,.09)*sh*.23
    for at in [.12,.34,.53]:
        q=clock(.28); put(x,sweep(q,120,40,25,12)+noise(q,rng,120,1500)*env(q,.001,19)*.12,at,.10)
    return room(x,.08)

def rain_impact(t,rng):
    # Local point impact, shorter/less broad than the v1 entire fire burst.
    x=sweep(t,290,53,31,12)*.46
    x+=noise(t,rng,170,3400)*env(t,.001,22)*.19
    x+=noise(t,rng,1500,9000)*env(t,.015,8)*.11
    x+=grit(t,rng,55,1200,8000,.035)
    return room(x,.065)

def ignite(t,rng):
    d=t[-1]; sh=(1-np.exp(-t*12))*np.exp(-t*2.1)
    x=noise(t,rng,130,4200)*sh*.25
    x+=np.sin(TAU*58*t+1.3*np.sin(TAU*17*t))*sh*.19
    x+=noise(t,rng,2300,8200)*env(t,.04,3.3)*.065
    x+=grit(t,rng,70,600,9300,.06)
    return room(x,.13)

def slot_unlock(t,rng):
    x=stone_impact(t,rng,1.15)*.28
    x+=rune_sequence(t,rng,[62,69,74],.10)*.30
    return room(x,.12)

def slot_submerged(t,rng):
    x=noise(t,rng,160,4700)*env(t,.02,3.7)*.17
    x+=sweep(t,190,40,4,3.5,.035)*.27
    for at,f in [(.12,210),(.38,160),(.61,115)]:
        q=clock(.28); put(x,sweep(q,f,45,12,14),at,.10)
    return room(x,.09)

def ui_error(t,rng):
    x=modal(t,246.94,15,.35)*.21+modal(t,233.08,17,.29)*.18
    x+=noise(t,rng,400,2600)*env(t,.001,45)*.065
    q=clock(.15); put(x,modal(q,196,18,.33),.095,.16)
    return x

def tactical(t,rng,opening):
    notes=[62,69,74] if opening else [74,69,62]
    x=rune_sequence(t,rng,notes,.05)*.30
    x+=noise(t,rng,450,3500)*env(t,.035,11)*.09
    x+=sweep(t,140 if opening else 310,310 if opening else 105,8,9,.02)*.10
    return room(x,.09)

def countdown(t,rng,final):
    x=modal(t,587.33 if final else 392,12 if final else 27,.48)*.30
    x+=noise(t,rng,800,4800)*env(t,.0008,65)*.06
    if final:
        x+=sweep(t,170,65,25,13)*.23
        q=clock(.42); put(x,modal(q,880,9,.48),.075,.21)
    return room(x,.07)

def main():
    movement='src/player/PlayerController.ts: handleJump/integrateVertical/isGrounded; no step/jump/land events'
    for i in range(4):
        render(f'sfx-footstep-stone-{i+1:02d}',f'黑曜石脚步 {i+1}',(.282,.29,.30,.31)[i],
               lambda t,r,v=i:step(t,r,v),'待移动声调度：isGrounded且水平累计距离达到步幅时播；四变体交替避免连重复，空中/冲刺/静止不播。',
               evidence=movement,mix_gain_db=-7)
    render('sfx-jump','离地蹬步',.44,jump,'待实际跳跃成功调用点；不能直接绑定空格按下，离地或冲刺时拒绝跳跃不播。',evidence=movement,mix_gain_db=-5)
    render('sfx-land-light','轻落石台',.44,lambda t,r:landing(t,r,False),'待落地判定点：空中→地面且下落距离足够时播放；初次出生落地、台阶吸附应抑制。',evidence=movement,mix_gain_db=-5)
    render('sfx-land-heavy','重落石台',.84,lambda t,r:landing(t,r,True),'待落地判定点按撞击前垂直速度或下落距离选择；与轻落互斥，当前快照不含vy。',evidence=movement,mix_gain_db=-2)
    render('sfx-lava-fall','坠入熔海',1.90,lava_fall,'PlayerDied.cause=lava 单次；可替代同次通用死亡声，避免两套死亡音叠加。',
           ['PlayerDied'],'observed_event','src/player/PlayerController.ts: die(lava)')
    render('sfx-player-low-health','生命将熄',1.28,low_health,'PlayerDamaged.amount>0 且hp从阈值上方跨到 0<hp<=max(1,ceil(maxHp*0.25))；冷却5秒，死亡优先；初始化快照静默。最新接力HP0直接失败，无复活声。',
           ['PlayerDamaged'],'observed_event','Merged PR #2: inherited HP, no respawn/regeneration',mix_gain_db=-1)
    render('sfx-mote-gain','熔核增益提示',.54,mote_gain,'MoteCountChanged正增量的可选通用资源提示；首次初始化静默，退款/调试设值不当作拾取，与出售声去重。',
           ['MoteCountChanged'],'observed_event','src/towers/TowerSystem.ts: place/upgrade/sell; GameLoop.setMotes',mix_gain_db=-4)
    render('sfx-execution-ready','可击破信号',.95,execution_ready,'预备：WeaknessProgress.executable 从false→true时单次；与弱点仅暴露不同，Boss/武器实际链路接入后使用。',
           ['WeaknessProgress'],'contract_only','src/core/events.ts: WeaknessProgress')
    render('sfx-execution-windup','击破凝力',.95,execution_windup,'预备：ExecutionStarted单次前摇，声音不含最终重击；ExecutionEnded且damage>0再用原sfx-execution。',
           ['ExecutionStarted'],'contract_only','src/core/events.ts: ExecutionStarted',mix_gain_db=-2)
    render('sfx-boss-interrupted','岩甲施法打断',1.20,interrupted,'预备：BossSkillInterrupted.by=interrupt/stagger；freeze用已有封冻音，避免同次事件双播。',
           ['BossSkillInterrupted'],'contract_only','src/core/events.ts: BossSkillInterrupted')
    render('sfx-boss-core-drain','塔心汲取循环',8,drain_loop,'预备：BossSkillStart skill=coreDrain,stage=active 开启单个循环；End/Interrupted/阶段退出时淡出，不能按帧重启。',
           ['BossSkillStart','BossSkillEnd','BossSkillInterrupted'],'planned_boss','src/boss/preview.ts: coreDrain',loop=True,mix_gain_db=-6)
    render('sfx-boss-rock-sweep','岩臂横扫',1.15,rock_sweep,'预备：rockSweep active出手，实际击中另用命中反馈；Boss当前主循环尚未接入。',
           ['BossSkillStart'],'planned_boss','src/boss/preview.ts: rockSweep')
    render('sfx-boss-stone-pillar','岩柱破地',1.55,stone_pillar,'预备：stonePillars active或独立岩柱破土点二选一；若多岩柱同帧合并限流。',
           ['BossSkillStart'],'planned_boss','src/boss/preview.ts: stonePillars')
    render('sfx-boss-lava-charge','熔躯冲撞',1.25,lava_charge,'预备：lavaCharge active出手；非循环，若技能提前中断则淡出。',
           ['BossSkillStart'],'planned_boss','src/boss/preview.ts: lavaCharge')
    render('sfx-boss-fire-rain-impact','火雨落点',.86,rain_impact,'预备：每颗火雨的实际落点回调；BossSkillStart只代表整次技能，不可当作每次撞地，当前契约缺少逐落点事件。',
           [],'needs_action_hook','src/boss/preview.ts: fireRain; no per-projectile impact event')
    render('sfx-boss-self-ignite','熔甲自燃',1.80,ignite,'预备：selfIgnite active单次，伴随体表引燃；不每帧重播，持续层另外控制。',
           ['BossSkillStart'],'planned_boss','src/boss/preview.ts: selfIgnite')
    render('sfx-slot-unlock','外环塔位解锁',1.10,slot_unlock,'TowerSlotStateChanged 仅locked→open；初始化open静默，同帧多塔位合并为一次，不把拆塔occupied→open当作解锁。',
           ['TowerSlotStateChanged'],'observed_event','src/towers/TowerSystem.ts: phaseChange / slot state updates',mix_gain_db=-3)
    render('sfx-slot-submerged','塔位被熔岩吞没',1.40,slot_submerged,'TowerSlotStateChanged open/occupied→submerged时单次；同帧TowerDestroyed.reason=drowned只保留优先声，避免双播。',
           ['TowerSlotStateChanged'],'observed_event','src/towers/TowerSystem.ts: LavaLevelChanged / submerged slots',mix_gain_db=-2)
    render('sfx-ui-error','建造拒绝',.36,ui_error,'待建塔/升级调用结果返回false或无效按钮操作时触发；并非TowerPlaced事件，当前契约没有专用失败事件。',
           [],'needs_action_hook','GameLoop.placeTower returns boolean; no build-rejected event',category='ui',mix_gain_db=-2)
    render('sfx-tactical-open','战术视图开启',.62,lambda t,r:tactical(t,r,True),'预备：TacticalViewChanged.open false→true；当前主循环未发布，需战术UI实际接入。',
           ['TacticalViewChanged'],'contract_only','src/core/events.ts: TacticalViewChanged',category='ui',mix_gain_db=-3)
    render('sfx-tactical-close','战术视图收束',.62,lambda t,r:tactical(t,r,False),'预备：TacticalViewChanged.open true→false；初始化静默，不与普通取消按钮重复播放。',
           ['TacticalViewChanged'],'contract_only','src/core/events.ts: TacticalViewChanged',category='ui',mix_gain_db=-3)
    render('sfx-countdown-tick','准备倒计时',.30,lambda t,r:countdown(t,r,False),'准备期最后3秒逐整数门限单次；读取timeline.tSec()/endsAtSec()，不可依赖不逐帧更新的snapshot.tSec；后台恢复不补播旧tick。',
           [],'needs_timeline_scheduler','src/flow/MatchTimeline.ts: tSec(), endsAtSec()',category='ui',mix_gain_db=-2)
    render('sfx-countdown-final','交战开始',.80,lambda t,r:countdown(t,r,True),'MatchPhaseChanged.phase=boss1 首次进入单次，可替代倒数0音；不得同时从倒数调度和阶段事件触发。',
           ['MatchPhaseChanged'],'observed_event','src/flow/MatchTimeline.ts: phase transition',category='ui')

if __name__=='__main__': main()
