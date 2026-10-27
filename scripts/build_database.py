#!/usr/bin/env python3
"""Build a reproducible, local MIMIC-IV ICU analysis database (stdlib only)."""
import argparse
import csv
import gzip
import json
import math
import sqlite3
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
METRICS = {
    220045: ('heart_rate', 'bpm'),
    220210: ('respiratory_rate', 'insp/min'),
    220277: ('spo2', '%'),
    220050: ('arterial_systolic', 'mmHg'),
    220051: ('arterial_diastolic', 'mmHg'),
    220052: ('arterial_mean', 'mmHg'),
    220179: ('noninvasive_systolic', 'mmHg'),
    220180: ('noninvasive_diastolic', 'mmHg'),
    220181: ('noninvasive_mean', 'mmHg'),
}
SOURCE_COLUMNS = {
    'patients': ['subject_id','gender','anchor_age','anchor_year','anchor_year_group','dod'],
    'admissions': ['subject_id','hadm_id','admittime','dischtime','deathtime','admission_type','admission_location','discharge_location','hospital_expire_flag'],
    'icustays': ['subject_id','hadm_id','stay_id','first_careunit','last_careunit','intime','outtime','los'],
    'd_items': ['itemid','label','unitname','category','linksto'],
}
INTS = {'subject_id','hadm_id','stay_id','anchor_age','anchor_year','hospital_expire_flag','itemid'}

def log(message):
    print(time.strftime('%H:%M:%S'), message, flush=True)

def connect(path):
    con = sqlite3.connect(path)
    con.execute('PRAGMA foreign_keys=ON')
    con.execute('PRAGMA journal_mode=WAL')
    con.execute('PRAGMA synchronous=NORMAL')
    con.execute('PRAGMA cache_size=-65536')
    return con

def load_sources(con, source):
    counts = {}
    for name, columns in SOURCE_COLUMNS.items():
        module = 'icu' if name in ('icustays','d_items') else 'hosp'
        pk = {'patients':'subject_id','admissions':'hadm_id','icustays':'stay_id','d_items':'itemid'}[name]
        fields = [f'{c} {"INTEGER" if c in INTS else "REAL" if c == "los" else "TEXT"}' + (' PRIMARY KEY' if c == pk else '') for c in columns]
        con.execute(f'CREATE TABLE {name} ({",".join(fields)})')
        sql = f'INSERT INTO {name} VALUES ({",".join("?" for _ in columns)})'
        count, batch = 0, []
        with gzip.open(source/module/(name+'.csv.gz'), 'rt', newline='') as stream:
            for row in csv.DictReader(stream):
                values = [None if row[c] == '' else int(row[c]) if c in INTS else float(row[c]) if c == 'los' else row[c] for c in columns]
                batch.append(values)
                if len(batch) == 10000:
                    con.executemany(sql, batch)
                    count += len(batch)
                    batch.clear()
            con.executemany(sql, batch)
            count += len(batch)
        con.commit()
        counts[name] = count
        log(f'Loaded {name}: {count:,}')
    con.executescript('CREATE INDEX admissions_subject ON admissions(subject_id); CREATE INDEX icustays_hadm ON icustays(hadm_id); CREATE INDEX icustays_subject ON icustays(subject_id);')
    return counts

def build_cohort(con):
    con.executescript('''
    CREATE TABLE cohort_exclusions (stay_id INTEGER PRIMARY KEY, subject_id INTEGER, hadm_id INTEGER, reason TEXT NOT NULL);
    CREATE TABLE icu_cohort (
      stay_id INTEGER PRIMARY KEY REFERENCES icustays(stay_id),
      subject_id INTEGER NOT NULL REFERENCES patients(subject_id),
      hadm_id INTEGER NOT NULL REFERENCES admissions(hadm_id),
      gender TEXT, age_estimate INTEGER, age_group TEXT, age_topcoded INTEGER NOT NULL,
      first_careunit TEXT, last_careunit TEXT, admission_type TEXT, discharge_location TEXT,
      admittime TEXT, dischtime TEXT, intime TEXT, outtime TEXT,
      icu_los_days REAL NOT NULL, hospital_los_days REAL NOT NULL,
      hospital_expire_flag INTEGER);
    CREATE TABLE data_quality_issues (stay_id INTEGER, issue TEXT NOT NULL);
    ''')
    rows = con.execute('''SELECT i.stay_id,i.subject_id,i.hadm_id,i.first_careunit,i.last_careunit,i.intime,i.outtime,i.los,
      p.subject_id,p.gender,p.anchor_age,p.anchor_year,
      a.subject_id,a.admittime,a.dischtime,a.admission_type,a.discharge_location,a.hospital_expire_flag
      FROM icustays i LEFT JOIN patients p ON i.subject_id=p.subject_id LEFT JOIN admissions a ON i.hadm_id=a.hadm_id''').fetchall()
    cohort, excluded, issues = [], [], []
    for r in rows:
        sid, subject, hadm, first, last, intime, outtime, source_los, psubject, gender, anchor_age, anchor_year, asubject, admittime, dischtime, admission_type, discharge, expired = r
        reason = None
        if psubject is None: reason = 'missing_patient'
        elif asubject is None: reason = 'missing_admission'
        elif asubject != subject: reason = 'subject_id_mismatch'
        else:
            try:
                adm, dis, tin, tout = [datetime.fromisoformat(x) for x in (admittime,dischtime,intime,outtime)]
                los = (tout-tin).total_seconds()/86400
                hlos = (dis-adm).total_seconds()/86400
                if los <= 0: reason = 'nonpositive_icu_duration'
                elif hlos <= 0: reason = 'nonpositive_hospital_duration'
                # Hospital and ICU administrative timestamps can differ; flag, do not exclude.
                elif tin < adm or tout > dis: issues.append((sid,'icu_outside_hospital_interval'))
            except (TypeError,ValueError): reason = 'missing_or_invalid_time'
        if reason:
            excluded.append((sid,subject,hadm,reason))
            continue
        age = None if anchor_age is None or anchor_year is None else anchor_age + adm.year - anchor_year
        topcoded = int(anchor_age == 91)
        if topcoded:
            age = None
            group = '90+'
        elif age is None: group = 'Unknown'
        elif age < 18: group = '<18'
        elif age < 40: group = '18-39'
        elif age < 65: group = '40-64'
        elif age < 80: group = '65-79'
        elif age < 90: group = '80-89'
        else: group = '90+'
        if age is not None and age < 0: issues.append((sid,'negative_age_estimate'))
        if source_los is None or abs(source_los-los) > 0.001: issues.append((sid,'source_los_differs_from_computed'))
        cohort.append((sid,subject,hadm,gender,age,group,topcoded,first,last,admission_type,discharge,admittime,dischtime,intime,outtime,los,hlos,expired))
    con.executemany('INSERT INTO icu_cohort VALUES ('+','.join('?' for _ in range(18))+')',cohort)
    con.executemany('INSERT INTO cohort_exclusions VALUES (?,?,?,?)',excluded)
    con.executemany('INSERT INTO data_quality_issues VALUES (?,?)',issues)
    con.executescript('''
    CREATE INDEX cohort_filters ON icu_cohort(first_careunit,age_group,gender);
    CREATE INDEX cohort_los ON icu_cohort(icu_los_days);
    CREATE INDEX cohort_subject ON icu_cohort(subject_id);
    CREATE INDEX cohort_hadm ON icu_cohort(hadm_id);
    CREATE VIEW cohort_overview AS SELECT COUNT(*) AS icu_stays, COUNT(DISTINCT subject_id) AS patients, COUNT(DISTINCT hadm_id) AS admissions, AVG(icu_los_days) AS mean_icu_los_days FROM icu_cohort;
    CREATE VIEW cohort_group_summary AS SELECT first_careunit,age_group,gender,COUNT(*) AS icu_stays,COUNT(DISTINCT subject_id) AS patients,AVG(icu_los_days) AS mean_icu_los_days FROM icu_cohort GROUP BY first_careunit,age_group,gender;
    CREATE TABLE vital_metrics(itemid INTEGER PRIMARY KEY REFERENCES d_items(itemid), metric TEXT NOT NULL, expected_unit TEXT NOT NULL);
    CREATE TABLE vital_observations (
      observation_id INTEGER PRIMARY KEY, stay_id INTEGER NOT NULL REFERENCES icu_cohort(stay_id),
      itemid INTEGER NOT NULL REFERENCES vital_metrics(itemid), charttime TEXT NOT NULL,
      storetime TEXT, value REAL NOT NULL, unit TEXT, hours_since_icu REAL NOT NULL,
      warning INTEGER, quality_flag TEXT);
    CREATE TABLE vital_extraction_audit(reason TEXT PRIMARY KEY, records INTEGER NOT NULL);
    CREATE TABLE pipeline_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    ''')
    con.executemany('INSERT INTO vital_metrics VALUES (?,?,?)',[(k,*v) for k,v in METRICS.items()])
    con.commit()
    return {'raw_icu_stays':len(rows),'included_icu_stays':len(cohort),'excluded_icu_stays':len(excluded),'exclusion_reasons':dict(Counter(r[3] for r in excluded)),'quality_issues':dict(Counter(r[1] for r in issues))}

def extract_vitals(con, source):
    cohort = {str(r[0]):r[1:] for r in con.execute('SELECT stay_id,subject_id,hadm_id,intime,outtime FROM icu_cohort')}
    audit = Counter()
    batch = []
    wanted = {str(k) for k in METRICS}
    scanned = 0
    started = time.monotonic()
    with gzip.open(source/'icu/chartevents.csv.gz','rt',newline='') as stream:
        header = next(stream).strip().split(',')
        assert header[:7] == ['subject_id','hadm_id','stay_id','caregiver_id','charttime','storetime','itemid']
        for line in stream:
            scanned += 1
            # First seven fields have no embedded delimiters. Fully parse only selected items.
            prefix = line.split(',',7)
            if prefix[6] in wanted:
                row = next(csv.reader([line]))
                audit['selected_metric_records'] += 1
                stay = cohort.get(row[2])
                if stay is None: audit['excluded_or_unknown_stay'] += 1; continue
                subject, hadm, tin, tout = stay
                if int(row[0]) != subject or int(row[1]) != hadm: audit['identifier_mismatch'] += 1; continue
                try:
                    value = float(row[8])
                    if not math.isfinite(value): raise ValueError()
                except ValueError: audit['missing_or_nonfinite_value'] += 1; continue
                charttime = row[4]
                try:
                    dt = datetime.fromisoformat(charttime)
                except ValueError: audit['invalid_charttime'] += 1; continue
                if charttime < tin or charttime > tout: audit['outside_icu_interval'] += 1; continue
                item = int(row[6])
                if row[9] != METRICS[item][1]: audit['unexpected_or_missing_unit'] += 1; continue
                # Flag suspect values; retain original finite measurements for traceability.
                flag = 'outside_display_range' if (value < 0 or (item == 220277 and value > 100) or (item == 220045 and value > 350) or (item == 220210 and value > 100) or (item not in (220045,220210,220277) and value > 400)) else None
                if flag: audit['flagged_value_records'] += 1
                hours = (dt-datetime.fromisoformat(tin)).total_seconds()/3600
                batch.append((int(row[2]),item,charttime,row[5] or None,value,row[9],hours,int(row[10]) if row[10] else None,flag))
                audit['retained_before_deduplication'] += 1
                if len(batch) >= 50000:
                    con.executemany('INSERT INTO vital_observations(stay_id,itemid,charttime,storetime,value,unit,hours_since_icu,warning,quality_flag) VALUES (?,?,?,?,?,?,?,?,?)',batch)
                    con.commit()
                    batch.clear()
            if scanned % 5000000 == 0:
                log(f'Vital scan {scanned:,} rows; retained {audit["retained_before_deduplication"]:,}; elapsed {time.monotonic()-started:.0f}s')
    con.executemany('INSERT INTO vital_observations(stay_id,itemid,charttime,storetime,value,unit,hours_since_icu,warning,quality_flag) VALUES (?,?,?,?,?,?,?,?,?)',batch)
    con.commit()
    log('Building vital indexes and deduplicating exact analysis records')
    con.execute('CREATE INDEX vital_exact ON vital_observations(stay_id,itemid,charttime,storetime,value,unit,warning)')
    con.execute('''DELETE FROM vital_observations WHERE observation_id NOT IN (SELECT MIN(observation_id) FROM vital_observations GROUP BY stay_id,itemid,charttime,storetime,value,unit,warning)''')
    audit['exact_duplicates_removed'] = con.execute('SELECT changes()').fetchone()[0]
    con.execute('DROP INDEX vital_exact')
    con.execute('CREATE INDEX vital_stay_metric_time ON vital_observations(stay_id,itemid,charttime)')
    con.execute('CREATE INDEX vital_item_stay ON vital_observations(itemid,stay_id)')
    con.executescript('''
    CREATE TABLE vital_coverage AS SELECT itemid,COUNT(*) AS observations,COUNT(DISTINCT stay_id) AS stays_with_data,SUM(quality_flag IS NOT NULL) AS flagged_observations FROM vital_observations GROUP BY itemid;
    CREATE TABLE stay_vital_summary AS SELECT stay_id,itemid,COUNT(*) AS observations,MIN(hours_since_icu) AS first_hour,MAX(hours_since_icu) AS last_hour,MIN(CASE WHEN quality_flag IS NULL THEN value END) AS minimum,MAX(CASE WHEN quality_flag IS NULL THEN value END) AS maximum,AVG(CASE WHEN quality_flag IS NULL THEN value END) AS mean FROM vital_observations GROUP BY stay_id,itemid;
    CREATE UNIQUE INDEX stay_vital_summary_key ON stay_vital_summary(stay_id,itemid);
    CREATE VIEW vital_hourly AS SELECT stay_id,itemid,CAST(hours_since_icu AS INTEGER) AS hour,AVG(value) AS mean_value,MIN(value) AS min_value,MAX(value) AS max_value,COUNT(*) AS observations FROM vital_observations WHERE quality_flag IS NULL GROUP BY stay_id,itemid,CAST(hours_since_icu AS INTEGER);
    ''')
    audit['scanned_records'] = scanned
    audit['retained_records'] = con.execute('SELECT COUNT(*) FROM vital_observations').fetchone()[0]
    con.executemany('INSERT INTO vital_extraction_audit VALUES (?,?)',audit.items())
    con.commit()
    return dict(audit)

def report(con, result, output):
    result['overview'] = dict(zip(['icu_stays','patients','admissions','mean_icu_los_days'], con.execute('SELECT * FROM cohort_overview').fetchone()))
    times = [r[0] for r in con.execute('SELECT icu_los_days FROM icu_cohort ORDER BY icu_los_days')]
    n = len(times)
    result['overview']['median_icu_los_days'] = (times[(n-1)//2]+times[n//2])/2 if n else None
    result['icu_types'] = [dict(zip(['icu_type','stays'],r)) for r in con.execute('SELECT first_careunit,COUNT(*) FROM icu_cohort GROUP BY first_careunit ORDER BY COUNT(*) DESC')]
    result['validation'] = {'quick_check':con.execute('PRAGMA quick_check').fetchone()[0], 'foreign_key_violations':len(con.execute('PRAGMA foreign_key_check').fetchall()), 'unique_stay_ids':con.execute('SELECT COUNT(DISTINCT stay_id)=COUNT(*) FROM icu_cohort').fetchone()[0] == 1}
    result['vital_coverage'] = [dict(zip(['metric','itemid','observations','stays_with_data','flagged_observations'],r)) for r in con.execute('SELECT m.metric,c.itemid,c.observations,c.stays_with_data,c.flagged_observations FROM vital_coverage c JOIN vital_metrics m USING(itemid)')] if con.execute("SELECT COUNT(*) FROM sqlite_master WHERE name='vital_coverage'").fetchone()[0] else []
    output.mkdir(parents=True,exist_ok=True)
    (output/'quality_report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    for table in ('cohort_exclusions','vital_coverage'):
        if not con.execute('SELECT COUNT(*) FROM sqlite_master WHERE name=?',(table,)).fetchone()[0]: continue
        cursor = con.execute('SELECT * FROM '+table)
        with (output/(table+'.csv')).open('w',newline='') as f:
            writer=csv.writer(f); writer.writerow([c[0] for c in cursor.description]); writer.writerows(cursor)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',type=Path,default=ROOT/'mimiciv/3.1')
    parser.add_argument('--database',type=Path,default=ROOT/'data/icu_analysis.sqlite')
    parser.add_argument('--vitals-only',action='store_true',help='Resume after a successful core-only build; requires an empty vital table')
    parser.add_argument('--core-only',action='store_true')
    args=parser.parse_args()
    args.database.parent.mkdir(parents=True,exist_ok=True)
    report_dir=ROOT/'reports'
    if args.vitals_only:
        con=connect(args.database)
        if con.execute('SELECT COUNT(*) FROM vital_observations').fetchone()[0]: raise SystemExit('Vital table not empty; resume is not supported after a partial vital scan. Use a new database path.')
        result=json.loads((report_dir/'quality_report.json').read_text())
    else:
        if args.database.exists(): raise SystemExit('Database already exists. Use a new --database path to avoid overwriting results.')
        con=connect(args.database)
        result={'dataset':'MIMIC-IV 3.1','source':str(args.source.resolve()),'built_at':datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds'),'source_rows':load_sources(con,args.source)}
        result['cohort']=build_cohort(con)
        con.execute('INSERT INTO pipeline_metadata VALUES (?,?)',('vitals_status','pending'))
        con.commit()
        report(con,result,report_dir)
        log(f'Core cohort complete: {result["cohort"]}')
    if not args.core_only:
        con.execute("UPDATE pipeline_metadata SET value='running' WHERE key='vitals_status'")
        con.commit()
        result['vitals']=extract_vitals(con,args.source)
        con.execute("UPDATE pipeline_metadata SET value='complete' WHERE key='vitals_status'")
        con.commit()
        report(con,result,report_dir)
    con.execute('ANALYZE')
    con.commit()
    con.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    con.close()
    log('Build complete: '+str(args.database))

if __name__=='__main__': main()
