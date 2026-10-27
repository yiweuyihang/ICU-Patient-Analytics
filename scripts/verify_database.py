"""Validate data identities, ranges, aggregates and referential integrity."""
import json
import sqlite3
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
con=sqlite3.connect(ROOT/'data/icu_analysis.sqlite')
report=json.loads((ROOT/'reports/quality_report.json').read_text())
checks={
    'database_integrity':con.execute('PRAGMA quick_check').fetchone()[0]=='ok',
    'foreign_keys':not con.execute('PRAGMA foreign_key_check').fetchall(),
    'cohort_accounting':con.execute('SELECT (SELECT COUNT(*) FROM icu_cohort)+(SELECT COUNT(*) FROM cohort_exclusions)=(SELECT COUNT(*) FROM icustays)').fetchone()[0]==1,
    'positive_durations':con.execute('SELECT COUNT(*) FROM icu_cohort WHERE icu_los_days<=0 OR hospital_los_days<=0').fetchone()[0]==0,
    'patient_admission_identity':con.execute('SELECT COUNT(*) FROM icu_cohort c JOIN admissions a USING(hadm_id) WHERE c.subject_id<>a.subject_id').fetchone()[0]==0,
    'topcoded_age_is_not_exact':con.execute('SELECT COUNT(*) FROM icu_cohort WHERE age_topcoded=1 AND (age_estimate IS NOT NULL OR age_group<>\'90+\')').fetchone()[0]==0,
    'vitals_complete':con.execute("SELECT value FROM pipeline_metadata WHERE key='vitals_status'").fetchone()[0]=='complete',
    'vitals_within_icu':con.execute('SELECT COUNT(*) FROM vital_observations v JOIN icu_cohort c USING(stay_id) WHERE v.charttime<c.intime OR v.charttime>c.outtime OR v.hours_since_icu<0').fetchone()[0]==0,
    'coverage_counts':con.execute('SELECT (SELECT SUM(observations) FROM vital_coverage)=(SELECT COUNT(*) FROM vital_observations)').fetchone()[0]==1,
    'stay_summary_counts':con.execute('SELECT (SELECT SUM(observations) FROM stay_vital_summary)=(SELECT COUNT(*) FROM vital_observations)').fetchone()[0]==1,
    'report_cohort_matches':con.execute('SELECT COUNT(*) FROM icu_cohort').fetchone()[0]==report['cohort']['included_icu_stays'],
    'report_vitals_match':con.execute('SELECT COUNT(*) FROM vital_observations').fetchone()[0]==report['vitals']['retained_records'],
}
payload={'checks':checks,'all_passed':all(checks.values())}
(ROOT/'reports/validation.json').write_text(json.dumps(payload,indent=2)+'\n')
print(json.dumps(payload,indent=2))
con.close()
if not payload['all_passed']: raise SystemExit(1)
