"""Master, encode and inspect generated assets. Uses installed FFmpeg; no downloads."""
from pathlib import Path
import concurrent.futures, hashlib, json, math, re, subprocess, wave
import numpy as np
import imageio_ffmpeg
from scipy import signal

ROOT=Path(__file__).resolve().parents[1]
FFMPEG=imageio_ffmpeg.get_ffmpeg_exe()
TARGETS={'music':-18.,'ambience':-28.,'sfx':-20.,'ui':-24.}

def ff(args):
    p=subprocess.run([FFMPEG,'-hide_banner','-nostdin']+args,capture_output=True)
    if p.returncode: raise RuntimeError(p.stderr.decode('utf-8',errors='replace'))
    return p

def loudness(path):
    p=ff(['-i',str(path),'-af','loudnorm=I=-18:TP=-3:LRA=11:print_format=json','-f','null','-'])
    text=p.stderr.decode('utf-8',errors='replace')
    m=re.search(r'\{\s*"input_i".*?\}',text,re.S)
    if not m: raise RuntimeError('No loudnorm measurement for '+str(path))
    data=json.loads(m.group())
    return {k:(float(data[k]) if math.isfinite(float(data[k])) else None) for k in ['input_i','input_tp','input_lra']}

def decoded(path, channels):
    p=ff(['-v','error','-i',str(path),'-f','f32le','-acodec','pcm_f32le','-'])
    return np.frombuffer(p.stdout,dtype='<f4').reshape(-1,channels)

def export(meta_path):
    m=json.loads(meta_path.read_text(encoding='utf-8'))
    name=m['id']; src=ROOT/'raw'/f'{name}.wav'
    measured=loudness(src)
    targets_by_id={'bgm-boss-phase1':-16.,'bgm-boss-phase2':-16.,'bgm-rage':-16.,
                   'bgm-tactical':-22.,'bgm-preparation':-19.,'bgm-molten-heart':-20.}
    target=targets_by_id.get(name,TARGETS[m['category']])
    raw=decoded(src,m['channels'])
    rms_db=20*np.log10(max(1e-12,float(np.sqrt(np.mean(raw.astype(float)**2)))))
    source_level=measured['input_i'] if measured['input_i'] is not None else rms_db
    # Preserve transients: if the true-peak ceiling prevents the LUFS target, do not limit them.
    gain=min(target-source_level,-3.0-(measured['input_tp'] or 0))
    wav=ROOT/'masters'/f'{name}.wav'; ogg=ROOT/'web'/f'{name}.ogg'
    ff(['-y','-i',str(src),'-af',f'volume={gain:.6f}dB','-ar','44100','-c:a','pcm_s24le',str(wav),
        '-af',f'volume={gain:.6f}dB','-ar','44100','-c:a','libvorbis','-q:a','4',
        '-metadata',f'TITLE={m["title"]}','-metadata','ARTIST=Molten Heart procedural audio',str(ogg)])
    pcm=decoded(wav,m['channels']); web=decoded(ogg,m['channels']); levels=loudness(ogg)
    failures=[]
    if not np.isfinite(web).all(): failures.append('nonfinite decoded samples')
    if len(pcm)!=len(raw): failures.append('WAV sample count mismatch')
    delta=len(web)-len(raw)
    alignment_lag=0
    tail_peak=None
    if delta:
        # libvorbis/FFmpeg may discard 128 trailing samples of short one-shots.
        # Accept only an already-faded tail with unchanged onset; loops stay exact.
        alignment_lag=int(np.argmax(signal.correlate(web[:,0],pcm[:,0],method='fft'))-(len(pcm)-1))
        tail_peak=float(np.max(np.abs(pcm[delta:]))) if delta<0 else None
        if m['loop'] or not (-128<=delta<0) or alignment_lag!=0 or tail_peak>10**(-50/20):
            failures.append('unacceptable decoded sample count/alignment difference')
    peak=float(np.max(np.abs(web)))
    if peak>=1: failures.append('decoded sample clipping')
    if levels['input_tp'] is not None and levels['input_tp']>-1: failures.append('true peak exceeds -1 dBTP')
    if float(np.max(np.abs(np.mean(pcm,axis=0))))>.005: failures.append('excessive DC')
    seam=float(np.max(np.abs(web[-1]-web[0]))) if m['loop'] else None
    if seam is not None and seam>.03: failures.append('loop endpoint jump exceeds 0.03 full scale')
    if float(np.sqrt(np.mean(pcm.astype(float)**2)))<1e-5: failures.append('silent asset')
    m.update(files={'ogg':f'web/{name}.ogg','wav':f'masters/{name}.wav'},
        web_bytes=ogg.stat().st_size,master_bytes=wav.stat().st_size,
        loop_start_sample=0 if m['loop'] else None,loop_end_sample=len(pcm) if m['loop'] else None,
        loudness_target_lufs=target,measured_ogg_lufs=levels['input_i'],measured_ogg_true_peak_dbtp=levels['input_tp'],
        loudness_method='EBU R128 via FFmpeg loudnorm; static gain limited to source -3 dBTP; short ungated assets use RMS',
        gain_db=round(gain,4),sample_peak_dbfs=round(20*np.log10(max(1e-12,peak)),3),
        decoded_ogg_samples=len(web),decoded_ogg_duration_seconds=len(web)/44100,
        decoded_length_delta_samples=delta,decoded_alignment_lag_samples=alignment_lag,
        omitted_tail_peak_dbfs=20*np.log10(max(1e-12,tail_peak)) if tail_peak is not None else None,
        codec_note='Exact samples' if delta==0 else '128 faded trailing samples omitted by Vorbis decoder; onset aligned; omitted tail below -50 dBFS',
        loop_endpoint_jump=seam,sha256_ogg=hashlib.sha256(ogg.read_bytes()).hexdigest(),
        verification='pass' if not failures else 'fail',failures=failures)
    prior_path=ROOT.parent/'metadata'/f'{name}.json'
    m['revision_status']='reworked' if name.startswith('bgm-') and prior_path.exists() else ('retained' if prior_path.exists() else 'new')
    print(f'{name}: {m["verification"]}; OGG {ogg.stat().st_size//1024} KB; {levels["input_i"]} LUFS; {levels["input_tp"]} dBTP',flush=True)
    return m

def main():
    metadata=sorted((ROOT/'metadata').glob('*.json'))
    if not metadata: raise SystemExit('No assets generated')
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool: assets=list(pool.map(export,metadata))
    report=dict(asset_count=len(assets),all_passed=all(a['verification']=='pass' for a in assets),
        web_total_bytes=sum(a['web_bytes'] for a in assets),master_total_bytes=sum(a['master_bytes'] for a in assets),
        verification_scope='Decode, sample count, signal levels, silence, DC, and loop endpoints. Not subjective listening or in-game integration.',assets=assets)
    (ROOT/'manifest.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    (ROOT/'reports'/'audio-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='assets'},ensure_ascii=False),flush=True)
    if not report['all_passed']: raise SystemExit(1)

if __name__=='__main__': main()
