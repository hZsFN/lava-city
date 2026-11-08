"""生成《渊底》——熔心孤塔 BGM 与几个关键音效。全部程序化合成，无任何第三方素材。"""
import numpy as np
from scipy import signal
import wave, os, struct

SR = 44100
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'audio')
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(20261108)


def write_wav(path, x):
    x = np.clip(x, -1.0, 1.0)
    data = (x * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())


def norm(x, peak=0.89):
    m = np.abs(x).max()
    return x / m * peak if m > 1e-9 else x


# ─────────────────────── BGM《渊底》96 秒循环 ───────────────────────
DUR = 96.0
N = int(SR * DUR)
t = np.arange(N) / SR

# 1. 低频 drone：D2(73.42) + A2(110)，各两路微失谐制造缓慢拍频
drone = np.zeros(N)
for f, amp, ph in [(73.42, 0.52, 0.0), (73.42 * 1.0031, 0.34, 1.7),
                   (110.0, 0.24, 3.1), (110.0 * 0.9987, 0.16, 4.4)]:
    lfo = 0.62 + 0.38 * np.sin(2 * np.pi * (0.0121 + ph * 0.0018) * t + ph)
    drone += amp * lfo * np.sin(2 * np.pi * f * t + ph)

# 2. 熔岩轰鸣：brown noise 低通 + 极慢起伏
wn = rng.standard_normal(N)
brown = np.cumsum(wn)
brown -= brown.mean()
brown /= np.abs(brown).max() + 1e-9
sos = signal.butter(4, 150 / (SR / 2), 'low', output='sos')
rumble = signal.sosfilt(sos, brown) * (0.52 + 0.48 * np.sin(2 * np.pi * 0.0187 * t + 0.9))

# 3. 心跳：52 BPM，S1 强 S2 弱；后段逐渐加快到 62
heart = np.zeros(N)
k = 0
t0 = 8.0
while t0 < DUR - 1.0:
    prog = t0 / DUR
    bpm = 52 + 12 * prog
    for dt, amp in [(0.0, 1.0), (0.27, 0.52)]:
        s = int((t0 + dt) * SR)
        L = int(0.5 * SR)
        if s + L > N:
            break
        tt = np.arange(L) / SR
        f = 64 * np.exp(-tt * 15) + 36
        heart[s:s + L] += amp * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 9.5) * (0.55 + 0.45 * prog)
    t0 += 60.0 / bpm

# 4. 熔岩咕嘟：随机低频气泡爆裂
gurgle = np.zeros(N)
for _ in range(26):
    s = int(rng.uniform(12, DUR - 2) * SR)
    L = int(rng.uniform(0.18, 0.42) * SR)
    if s + L > N:
        continue
    tt = np.arange(L) / SR
    f0 = rng.uniform(70, 190)
    f = f0 * (1.0 + 1.6 * tt / (L / SR))
    sig = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 11)
    sig *= rng.uniform(0.35, 1.0)
    gurgle[s:s + L] += sig
sos_g = signal.butter(3, 700 / (SR / 2), 'low', output='sos')
gurgle = signal.sosfilt(sos_g, gurgle)

# 5. 高频紧张：稀疏的玻璃摩擦（不和谐小九度）
glint = np.zeros(N)
for _ in range(9):
    s = int(rng.uniform(20, DUR - 3) * SR)
    L = int(rng.uniform(0.9, 1.9) * SR)
    if s + L > N:
        continue
    tt = np.arange(L) / SR
    base = rng.choice([1174.7, 1244.5, 1568.0])  # D6/Eb6/G6
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.2 * tt)
    sig = (np.sin(2 * np.pi * base * vib * tt) * 0.5
           + np.sin(2 * np.pi * base * 1.5 * vib * tt) * 0.25) * np.sin(np.pi * tt / (L / SR)) ** 2
    glint[s:s + L] += sig * 0.055

# 6. 混响：简单的多抽头反馈延迟
def reverb(x, decay=0.36, taps=(0.041, 0.067, 0.093, 0.131, 0.187, 0.251)):
    out = x.copy()
    for tap in taps:
        d = int(tap * SR)
        out[d:] += decay * x[:-d]
    return out

mix = drone * 0.55 + rumble * 0.62 + heart * 0.5 + gurgle * 0.42 + glint * 0.9
mix = reverb(mix, 0.30, (0.053, 0.089, 0.147, 0.211))

# 首尾交叉淡化，保证无缝循环（把尾巴叠回开头）
xf = int(3.0 * SR)
fade = np.linspace(0, 1, xf) ** 1.5
mix[:xf] = mix[:xf] * fade + mix[-xf:] * (1 - fade)
mix = mix[:-xf]
mix = norm(mix, 0.82)
write_wav(os.path.join(OUT, 'bgm-molten-heart.wav'), mix)
print('bgm ok', len(mix) / SR, 'sec')

# ─────────────────────── 音效 ───────────────────────
def sfx(name, x):
    x = norm(x, 0.9)
    write_wav(os.path.join(OUT, name), x)
    print('sfx', name, round(len(x) / SR, 2), 'sec')


# 击破：低频冲击 + 金属炸裂
L = int(2.6 * SR)
tt = np.arange(L) / SR
slam = np.sin(2 * np.pi * np.cumsum(38 + 180 * np.exp(-tt * 22)) / SR) * np.exp(-tt * 3.2)
crack = rng.standard_normal(L) * np.exp(-tt * 13) * 0.6
ring = sum(np.sin(2 * np.pi * f * tt) * np.exp(-tt * (2.4 + i)) * 0.28
           for i, f in enumerate([523, 784, 1046, 1568]))
sfx('sfx-execution.wav', slam * 0.9 + crack + ring)

# 弱点暴露：一段上扬的金属共鸣
L = int(1.5 * SR)
tt = np.arange(L) / SR
up = np.sin(2 * np.pi * np.cumsum(300 + 900 * tt / 1.5) / SR) * np.exp(-tt * 1.1)
up += np.sin(2 * np.pi * np.cumsum(450 + 1350 * tt / 1.5) / SR) * np.exp(-tt * 1.4) * 0.6
sfx('sfx-weakness-open.wav', up)

# 受击：短促钝响
L = int(0.4 * SR)
tt = np.arange(L) / SR
hit = np.sin(2 * np.pi * np.cumsum(90 + 240 * np.exp(-tt * 40)) / SR) * np.exp(-tt * 16)
hit += rng.standard_normal(L) * np.exp(-tt * 45) * 0.35
sfx('sfx-hit.wav', hit)

# 熔岩上涨：持续的低频涌动（可循环）
L = int(8.0 * SR)
tt = np.arange(L) / SR
rise = np.cumsum(rng.standard_normal(L)) * 0.02
sos_r = signal.butter(4, 240 / (SR / 2), 'low', output='sos')
rise = signal.sosfilt(sos_r, rise)
rise = rise * (0.5 + 0.5 * np.sin(2 * np.pi * 0.17 * tt))
rise += np.sin(2 * np.pi * 43 * tt) * 0.25
xf = int(0.6 * SR)
fade = np.linspace(0, 1, xf)
rise[:xf] = rise[:xf] * fade + rise[-xf:] * (1 - fade)
sfx('sfx-lava-rise.wav', rise[:-xf])
