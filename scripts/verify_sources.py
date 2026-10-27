"""Verify the five input files against the supplied SHA256SUMS manifest."""
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
source=ROOT/'mimiciv/3.1'
manifest={line.split(maxsplit=1)[1].strip():line.split(maxsplit=1)[0] for line in (source/'SHA256SUMS.txt').read_text().splitlines() if line.strip()}
inputs=['hosp/patients.csv.gz','hosp/admissions.csv.gz','icu/icustays.csv.gz','icu/d_items.csv.gz','icu/chartevents.csv.gz']
results=[]
for relative in inputs:
    path=source/relative
    digest=hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda:stream.read(8*1024*1024),b''): digest.update(chunk)
    actual=digest.hexdigest()
    results.append({'file':relative,'bytes':path.stat().st_size,'expected_sha256':manifest[relative],'actual_sha256':actual,'matches':actual==manifest[relative]})
    print(relative, 'OK' if actual==manifest[relative] else 'MISMATCH',flush=True)
payload={'all_passed':all(r['matches'] for r in results),'files':results}
(ROOT/'reports/source_validation.json').write_text(json.dumps(payload,indent=2)+'\n')
if not payload['all_passed']: raise SystemExit(1)
