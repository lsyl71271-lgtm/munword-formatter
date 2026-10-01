"""Exercise the same corrupt fixtures without human metadata overrides."""
import argparse, json, sys
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'backend'))
from app.pipelines import PIPELINES

parser=argparse.ArgumentParser(); parser.add_argument('source'); parser.add_argument('output'); args=parser.parse_args()
source=Path(args.source); output=Path(args.output); output.mkdir(parents=True,exist_ok=True)
templates=Path(__file__).resolve().parents[1]/'templates'/'pkunmun2026'
for fixture in json.loads((source/'manifest.json').read_text(encoding='utf8')):
    result=PIPELINES[fixture['type']](templates).run((source/fixture['file']).read_bytes())
    if any(item.status=='error' for item in result.validations): raise AssertionError(result.validations)
    (output/fixture['file']).write_bytes(result.content)
    print(fixture['file'],' '.join(f'{item.code}:{item.status}' for item in result.validations),flush=True)
