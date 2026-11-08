"""Shared deterministic audio render helpers. Writes only inside this asset pack."""
from pathlib import Path
import json, wave
import numpy as np
from scipy import signal
from scipy.io import wavfile

ROOT = Path(__file__).resolve().parents[1]
SR = 44100

def clock(seconds):
    return np.arange(round(seconds * SR), dtype=np.float64) / SR

def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)

def band(x, low=30, high=12000):
    return signal.sosfilt(signal.butter(2, [low, high], btype='bandpass', fs=SR, output='sos'), x, axis=0)

def env(t, attack=.005, decay=4, release=.02):
    e = (1-np.exp(-t/max(attack, .00001))) * np.exp(-t*decay)
    n = min(len(t), round(release*SR))
    if n: e[-n:] *= np.linspace(1,0,n)**2
    return e

def put(dst, x, at=0, gain=1, pan=0, wrap=False):
    if dst.ndim == 2 and x.ndim == 1:
        angle=(pan+1)*np.pi/4
        x=np.column_stack((x*np.cos(angle),x*np.sin(angle)))
    start=round(at*SR)
    if wrap:
        idx=(np.arange(len(x))+start)%len(dst)
        np.add.at(dst,idx,x*gain)
    else:
        a=max(0,start); b=min(len(dst),start+len(x))
        if b>a: dst[a:b]+=x[a-start:b-start]*gain

def room(x, wet=.13, wrap=False):
    out=x.copy()
    for i,d in enumerate([.043,.079,.127,.193,.283,.419,.617]):
        n=round(d*SR); g=wet*(.77**i)
        if wrap: out+=np.roll(x,n,axis=0)*g
        elif n<len(x): out[n:]+=x[:-n]*g
    return out

def write_asset(asset_id, x, title, category, loop=False, usage='', events=None, bpm=None):
    x=np.asarray(x,dtype=np.float64)
    if not np.isfinite(x).all(): raise ValueError(asset_id+' nonfinite')
    x-=x.mean(axis=0)
    if loop:
        # Remove only a residual endpoint discontinuity; arrangements wrap musical tails.
        n=min(256,len(x)//10)
        delta=x[-1]-x[0]
        ramp=np.linspace(0,1,n)**2
        if x.ndim==2: ramp=ramp[:,None]
        x[-n:]-=ramp*delta
    else:
        a=min(round(.003*SR),len(x)//4); b=min(round(.035*SR),len(x)//4)
        shape=(slice(None),None) if x.ndim==2 else slice(None)
        x[:a]*=np.linspace(0,1,a)[shape]
        x[-b:]*=np.linspace(1,0,b)[shape]
    peak=float(np.max(np.abs(x)))
    if peak>0: x*=.85/peak
    # Keep synthesis precision until the final PCM24 mastering stage.
    wavfile.write(str(ROOT/'raw'/f'{asset_id}.wav'), SR, x.astype(np.float32))
    meta=dict(id=asset_id,title=title,category=category,loop=loop,usage=usage,
              events=events or [],bpm=bpm,sample_rate=SR,channels=1 if x.ndim==1 else x.shape[1],duration_seconds=len(x)/SR)
    (ROOT/'metadata'/f'{asset_id}.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding='utf-8')
    print(f'{asset_id}: {len(x)/SR:.3f}s',flush=True)
