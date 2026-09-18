#!/usr/bin/env python3
"""Regression test: real 0000..0004 migrations; in-memory synthetic data only.
Usage: python3 tests/counters.test.py /absolute/site/path
No site, persistent D1, R2, or existing local database is opened for writes.
"""
import hashlib,json,random,sqlite3,sys
from pathlib import Path
ROOT=Path(sys.argv[1]) if len(sys.argv)>1 else Path.cwd()
NOW=1789430400000

def state(c):return dict(c.execute('SELECT * FROM community_state WHERE id=1').fetchone())
def plan(c):
 s=state(c)
 if s['ready']:return None
 phase,cursor=s['backfill_phase'],s['backfill_cursor']
 table='opinions' if phase=='opinions' else 'sessions' if phase=='sessions' else 'impressions'
 rows=c.execute(f'SELECT rowid AS seq,id FROM {table} WHERE rowid>? ORDER BY rowid LIMIT 25',(cursor,)).fetchall()
 return phase,cursor,rows

def apply_page(c,p):
 if p is None:return state(c)
 phase,cursor,rows=p
 with c:
  for row in rows:
   rid=row['id']
   if phase=='opinions':
    c.execute('''UPDATE opinions SET agree_count=(SELECT COUNT(*) FROM votes WHERE opinion_id=? AND unrelated=0 AND value=-1),disagree_count=(SELECT COUNT(*) FROM votes WHERE opinion_id=? AND unrelated=0 AND value=1),pass_count=(SELECT COUNT(*) FROM votes WHERE opinion_id=? AND unrelated=0 AND value=0),unrelated_count=(SELECT COUNT(*) FROM votes WHERE opinion_id=? AND unrelated=1) WHERE id=? AND EXISTS(SELECT 1 FROM community_state WHERE ready=0 AND backfill_phase=? AND backfill_cursor=?)''',(rid,rid,rid,rid,rid,phase,cursor))
   elif phase=='sessions':
    c.execute('''UPDATE sessions SET approved_vote_count=(SELECT COUNT(*) FROM votes v JOIN opinions o ON o.id=v.opinion_id WHERE v.session_id=? AND o.status='approved') WHERE id=? AND EXISTS(SELECT 1 FROM community_state WHERE ready=0 AND backfill_phase=? AND backfill_cursor=?)''',(rid,rid,phase,cursor))
   else:
    c.execute("INSERT OR IGNORE INTO events(id,session_id,type,impression_id,created_at) SELECT 'retired:'||id,session_id,'retired',id,retired_at FROM impressions WHERE id=? AND retired_at IS NOT NULL",(rid,))
  next_phase=phase if len(rows)==25 else 'sessions' if phase=='opinions' else 'impressions' if phase=='sessions' else 'done'
  c.execute('UPDATE community_state SET backfill_phase=?,backfill_cursor=? WHERE id=1 AND ready=0 AND backfill_phase=? AND backfill_cursor=?',(next_phase,rows[-1]['seq'] if next_phase==phase else 0,phase,cursor))
  if next_phase=='done':
   c.execute("UPDATE community_state SET votes=(SELECT COALESCE(SUM(agree_count+disagree_count+pass_count+unrelated_count),0) FROM opinions WHERE status='approved'),sessions=(SELECT COUNT(*) FROM sessions WHERE approved_vote_count>0),revision=revision+1,ready=1 WHERE id=1 AND ready=0 AND backfill_phase='done'")
 return state(c)

def backfill(c):
 pages=0
 while not state(c)['ready']:
  apply_page(c,plan(c));pages+=1
  assert pages<1000,'backfill did not terminate'
 return pages

def verify(c):
 for o in c.execute('SELECT id,agree_count,disagree_count,pass_count,unrelated_count FROM opinions'):
  actual=tuple(c.execute('SELECT COALESCE(SUM(unrelated=0 AND value=-1),0),COALESCE(SUM(unrelated=0 AND value=1),0),COALESCE(SUM(unrelated=0 AND value=0),0),COALESCE(SUM(unrelated=1),0) FROM votes WHERE opinion_id=?',(o['id'],)).fetchone())
  assert tuple(o)[1:]==actual,('opinion counter mismatch',o['id'],tuple(o)[1:],actual)
 for s in c.execute('SELECT id,approved_vote_count FROM sessions'):
  actual=c.execute("SELECT COUNT(*) FROM votes v JOIN opinions o ON o.id=v.opinion_id WHERE v.session_id=? AND o.status='approved'",(s['id'],)).fetchone()[0]
  assert s['approved_vote_count']==actual,('session counter mismatch',s['id'])
 actual=tuple(c.execute("SELECT COUNT(*),COUNT(DISTINCT session_id) FROM votes v JOIN opinions o ON o.id=v.opinion_id WHERE o.status='approved'").fetchone())
 assert actual==tuple(c.execute('SELECT votes,sessions FROM community_state WHERE id=1').fetchone()),('community mismatch',actual,state(c))
 assert not c.execute('PRAGMA foreign_key_check').fetchall()

def blocked(c,sql,args=()):
 c.execute('SAVEPOINT guard_probe')
 try:
  c.execute(sql,args)
  return False
 except sqlite3.IntegrityError as e:
  assert 'initializing' in str(e).lower(),str(e)
  return True
 finally:
  c.execute('ROLLBACK TO guard_probe');c.execute('RELEASE guard_probe')

c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row;c.execute('PRAGMA foreign_keys=ON')
files=sorted((ROOT/'drizzle').glob('*.sql'))
old=[p for p in files if p.name[:4] in ['0000','0001','0002','0003']]
new=[p for p in files if p.name.startswith('0004')]
assert len(old)==4 and len(new)==1,(old,new)
for p in old:c.executescript(p.read_text())
for n in range(65):c.execute('INSERT INTO sessions(id,token_hash,phase,created_at,notice_version) VALUES(?,?,?,?,?)',(f's{n}',hashlib.sha256(f's{n}'.encode()).hexdigest(),'ended' if n%2 else 'active',NOW,'legacy-notice'))
for n in range(60):c.execute('INSERT INTO opinions(id,tag_id,text,kind,source_ids,created_at,status) VALUES(?,?,?,?,?,?,?)',(f'o{n}',f'tag{n%8}',f'既存の政策意見 {n}','seed' if n<40 else 'participant','[]',NOW,['approved','hidden','approved','pending','rejected'][n%5]))
responses=[(-1,0),(1,0),(0,0),(0,1)]
for s in range(65):
 for j in range(20):
  o=(s*7+j)%60;v,u=responses[(s+j)%4]
  c.execute('INSERT INTO votes(session_id,opinion_id,value,unrelated,created_at) VALUES(?,?,?,?,?)',(f's{s}',f'o{o}',v,u,NOW+j))
 for j in range(4):
  iid=f'i{s}-{j}';retired=NOW+100 if (s+j)%3==0 else None
  c.execute('INSERT INTO impressions(id,session_id,opinion_id,sequence,text_snapshot,tag_snapshot,source_snapshot,kind_snapshot,routing_version,probability,candidates,issued_at,retired_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',(iid,f's{s}',f'o{(s+j)%60}',j+1,'既存の本文',json.dumps({'id':f'tag{(s+j)%8}'}),'[]','seed','legacy-router',.025,'{"legacy":true}',NOW,retired))
  if retired and s<2:c.execute('INSERT INTO events(id,session_id,type,impression_id,created_at) VALUES(?,?,?,?,?)',('retired:'+iid,f's{s}','retired',iid,retired))
c.execute("INSERT INTO result_snapshots VALUES('legacy-snapshot','{\"legacy\":true}',?)",(NOW,))
c.execute("INSERT INTO releases(id,sha256,object_key,status,created_at,summary,opinion_revisions,actor,reason) VALUES('legacy-release','hash','legacy/object','released',?,'{}','{}','tester','old release')",(NOW,))
c.commit()
original_votes=[tuple(x) for x in c.execute('SELECT session_id,opinion_id,value,unrelated,created_at,impression_id FROM votes ORDER BY session_id,opinion_id')]
for p in new:c.executescript(p.read_text())
assert state(c)['ready']==0
assert c.execute("SELECT schema_version,phase FROM releases WHERE id='legacy-release'").fetchone()[:]==(2,'done')
assert blocked(c,"INSERT INTO sessions(id,token_hash,phase,created_at) VALUES('blocked','blocked','active',?)",(NOW,))
assert blocked(c,"INSERT OR IGNORE INTO votes(session_id,opinion_id,value,unrelated,created_at) VALUES('s0','o59',-1,0,?)",(NOW,))
assert blocked(c,"UPDATE opinions SET status='hidden',revision=revision+1 WHERE id='o0'")
print('PASS: real 0004 migration preserves legacy rows and blocks stale-worker session/vote/metadata writes while ready=0.')
# Two callers read the same cursor before either applies a page.
p=plan(c);apply_page(c,p);after=state(c);apply_page(c,p);assert state(c)==after
print('PASS: duplicate/stale first-page application does not advance twice.')
# Independently reproduce the missing ready=0 DELETE guard, if still present.
c.commit();race=sqlite3.connect(':memory:');race.row_factory=sqlite3.Row;c.backup(race)
if not blocked(race,"DELETE FROM votes WHERE session_id='s0' AND opinion_id='o0'"):
 race.execute("DELETE FROM votes WHERE session_id='s0' AND opinion_id='o0'");race.commit();backfill(race)
 try:verify(race)
 except AssertionError as e:print('FINDING: ready=0 DELETE after opinion-page backfill causes stale counters:',str(e))
 else:raise AssertionError('Expected maintenance DELETE race was not reproduced')
else:print('PASS: maintenance DELETE is also blocked.')
race.close()
pages=backfill(c);verify(c)
assert original_votes==[tuple(x) for x in c.execute('SELECT session_id,opinion_id,value,unrelated,created_at,impression_id FROM votes ORDER BY session_id,opinion_id')]
retired=c.execute('SELECT COUNT(*) FROM impressions WHERE retired_at IS NOT NULL').fetchone()[0]
assert c.execute("SELECT COUNT(*) FROM events WHERE type='retired'").fetchone()[0]==retired
assert c.execute("SELECT COUNT(*) FROM (SELECT impression_id FROM events WHERE type='retired' GROUP BY impression_id HAVING COUNT(*)!=1)").fetchone()[0]==0
print(f'PASS: paged backfill completed ({pages} further pages), exact raw counters, legacy votes unchanged, {retired} retirement events deduplicated.')
before=state(c);apply_page(c,None);assert state(c)==before
old=tuple(c.execute('SELECT session_id,opinion_id,value,unrelated,created_at FROM votes LIMIT 1').fetchone());before=state(c)
c.execute('INSERT OR IGNORE INTO votes(session_id,opinion_id,value,unrelated,created_at) VALUES(?,?,?,?,?)',old);assert state(c)==before;verify(c)
o='o0';c.execute("UPDATE opinions SET status='hidden',revision=revision+1 WHERE id=?",(o,));verify(c);before=state(c)
c.execute("UPDATE opinions SET status='hidden' WHERE id=?",(o,));assert state(c)==before;verify(c)
c.execute("UPDATE opinions SET status='approved',revision=revision+1 WHERE id=?",(o,));verify(c)
before=state(c);c.execute("UPDATE opinions SET text=text||' 修正',tag_id='edited',revision=revision+1 WHERE id=?",(o,));after=state(c);assert after['revision']==before['revision']+1 and after['moderation_revision']==before['moderation_revision']+1;verify(c)
# Retirement trigger emits one immutable event even if called repeatedly.
i=c.execute('SELECT id FROM impressions WHERE retired_at IS NULL LIMIT 1').fetchone()[0]
c.execute('UPDATE impressions SET retired_at=? WHERE id=?',(NOW+500,i));c.execute('UPDATE impressions SET retired_at=? WHERE id=?',(NOW+600,i));assert c.execute("SELECT COUNT(*) FROM events WHERE id=?",('retired:'+i,)).fetchone()[0]==1
r=random.Random(29)
for step in range(1000):
 s,o=f's{r.randrange(65)}',f'o{r.randrange(60)}';a=r.randrange(4)
 if a<2:
  v,u=r.choice(responses);c.execute('INSERT OR IGNORE INTO votes(session_id,opinion_id,value,unrelated,created_at) VALUES(?,?,?,?,?)',(s,o,v,u,NOW+step))
 elif a==2:c.execute('DELETE FROM votes WHERE session_id=? AND opinion_id=?',(s,o))
 else:c.execute('UPDATE opinions SET status=? WHERE id=?',(r.choice(['approved','hidden','pending','rejected']),o))
 verify(c)
print('PASS: duplicate INSERT, hide/repeated-hide/restore, metadata revisions, retirements, and 1000 mixed operations agree with raw recounts.')
try:
 c.execute("UPDATE votes SET value=-value WHERE rowid=(SELECT MIN(rowid) FROM votes)")
except sqlite3.IntegrityError as e:
 assert 'immutable' in str(e).lower()
else:raise AssertionError('Saved vote UPDATE was not blocked')
print('PASS: saved response UPDATE is prohibited at the database boundary.')
queries={
 'vote impression linkage':("SELECT 1 FROM votes WHERE impression_id=?",('i0-0',),'idx_votes_impression'),
 'moderation affected sessions':("SELECT session_id FROM votes WHERE opinion_id=?",('o0',),'idx_votes_opinion_session'),
 'session votes':("SELECT opinion_id,value,unrelated FROM votes WHERE session_id=?",('s0',),'sqlite_autoindex_votes_1'),
 'open opinion impressions':("SELECT id FROM impressions WHERE opinion_id=? AND answered_at IS NULL AND retired_at IS NULL",('o0',),'idx_impressions_opinion_open'),
 'events by impression/type':("SELECT id FROM events WHERE impression_id=? AND type=?",('i0-0','retired'),'idx_events_impression_type'),
 'seed count':("SELECT COUNT(*) FROM opinions WHERE kind='seed'",(),'idx_opinions_kind'),
 'approved opinion counters':("SELECT id,agree_count,disagree_count,pass_count,unrelated_count FROM opinions WHERE status='approved'",(),'idx_opinions_status'),
}
for name,(sql,args,index) in queries.items():
 detail=' | '.join(row[3] for row in c.execute('EXPLAIN QUERY PLAN '+sql,args));assert index in detail,(name,detail);print('PLAN:',name,':',detail)
print('PASS: all intended indexes selected. Only SQLite :memory: was written; site and all persisted databases unchanged.')
