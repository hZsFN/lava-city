"""Read-only hash verification for the existing game workspaces."""
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
import hashlib, json, os, sys
ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT.parents[1]
EXCLUDED={'.git','node_modules','dist','build','out','.vite','__pycache__','.codex','.agents'}
GAME_DIRS=['lava-city','wt-p2a','p2b-1','p2b-2','p2b-3']
def scan():
    found={}
    for name in GAME_DIRS:
        for folder, dirs, files in os.walk(BASE/name):
            dirs[:]=[d for d in dirs if d not in EXCLUDED]
            for file in files:
                p=Path(folder)/file
                if p.name=='.git': continue
                found[p.relative_to(BASE).as_posix()]=hashlib.sha256(p.read_bytes()).hexdigest()
    for name in ['_t.md','_t1.md','GIT-CONNECTION.md']:
        p=BASE/name
        if p.exists(): found[name]=hashlib.sha256(p.read_bytes()).hexdigest()
    return found
if __name__=='__main__':
    baseline=ROOT/'reports'/'originals-baseline.json'
    current=scan()
    if '--baseline' in sys.argv:
        if baseline.exists(): raise SystemExit('Baseline already exists; refusing overwrite')
        baseline.write_text(json.dumps(current,indent=2,ensure_ascii=False),encoding='utf-8')
        print(f'Baseline recorded: {len(current)} original files')
    else:
        old=json.loads(baseline.read_text(encoding='utf-8'))
        result=dict(checked_files=len(old),changed=[p for p in old if p in current and old[p]!=current[p]],
                    missing=[p for p in old if p not in current],added=[p for p in current if p not in old],
                    scope=GAME_DIRS+['_t.md','_t1.md','GIT-CONNECTION.md'],excluded=sorted(EXCLUDED))
        (ROOT/'reports'/'originals-verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(result,ensure_ascii=False))
        sys.exit(1 if result['changed'] or result['missing'] else 0)

