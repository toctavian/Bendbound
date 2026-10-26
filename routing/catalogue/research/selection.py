"""Derive a policy-authorized subset without changing or rerunning the source review."""
import copy
import hashlib
import json
import math
from pathlib import Path

HERE=Path(__file__).resolve().parent
FLAGS=('accountingPassed','graphIdentityPassed','historyReviewComplete')


def fingerprint(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',', ':'),ensure_ascii=True).encode()).hexdigest()


def rules():
    return json.loads((HERE/'single_review_rules.json').read_text())


def select(proposal,review,context,legacy_authorization=None):
    policy=rules()
    # Old fully approved batches retain their exact original payload for replay.
    if 'integrity' not in review and review.get('approved') is True:
        return proposal,review,{'policyId':'legacy-whole-batch','quarantined':[],'rejected':[]}
    for key,expected in [('reviewedProposalSha256',fingerprint(proposal)),
                         ('reviewedBaselineSha256',context['baselineSha256']),
                         ('reviewedLedgerSha256',context['ledgerSha256'])]:
        if review.get(key)!=expected:raise ValueError('Review/input binding mismatch')
    origin=fingerprint(review)
    integrity=review.get('integrity')
    legacy=False
    if integrity is None:
        # A legacy held review is never implicitly converted into approval.
        a=legacy_authorization or {}
        if a.get('sourceReviewSha256')!=origin or a.get('policyId')!=policy['policyId'] or a.get('runId')!=context['runId']:
            raise ValueError('Held legacy review requires a specific, recorded policy adoption')
        integrity=a.get('integrity');legacy=True
    if not isinstance(integrity,dict) or any(integrity.get(k) is not True for k in FLAGS) or integrity.get('issues')!=[]:
        raise ValueError('Whole-batch integrity checks did not pass')
    expected={}
    for page in proposal['pages']:
        for road in page['roads']:
            key=(page['url'],road['sectionId'])
            if key in expected:raise ValueError('Duplicate proposed observation identity')
            expected[key]=road
    decisions={};quarantined=[];rejected=[]
    for d in review['decisions']:
        key=(d['url'],d['sectionId'])
        if key not in expected or key in decisions:raise ValueError('Incomplete or duplicate review coverage')
        weight=d['weight']
        if isinstance(weight,bool) or not isinstance(weight,(float,int)) or not math.isfinite(weight) or not 0<=weight<=1:
            raise ValueError('Invalid review weight')
        disposition=d.get('disposition')
        if legacy:disposition='supported' if weight>0 else 'quarantined'
        if disposition not in {'supported','quarantined','rejected'} or (disposition=='supported')!=(weight>0):
            raise ValueError('Review disposition conflicts with evidence weight')
        decisions[key]=d
        if disposition!='supported':
            (quarantined if disposition=='quarantined' else rejected).append(copy.deepcopy(d))
    if set(decisions)!=set(expected):raise ValueError('Review must cover every observation')
    pages=[];chosen=[]
    for page in proposal['pages']:
        roads=[r for r in page['roads'] if decisions[(page['url'],r['sectionId'])]['weight']>0]
        if roads:
            pages.append({**page,'roads':roads})
            chosen.extend(copy.deepcopy(decisions[(page['url'],r['sectionId'])]) for r in roads)
    adjustments=[]
    for change in review.get('adjustments',[]):
        disposition=change.get('disposition','supported' if legacy else None)
        if disposition not in {'supported','quarantined','rejected'}:raise ValueError('Missing correction disposition')
        if disposition=='supported' and policy['automaticHistoricalCorrections']:
            adjustments.append(copy.deepcopy(change))
        else:
            (rejected if disposition=='rejected' else quarantined).append(copy.deepcopy(change))
    selected={**proposal,'pages':pages}
    authorization={
        'approved':True, 'authorizationType':policy['policyId'],
        'sourceReviewSha256':origin,'sourceProposalSha256':fingerprint(proposal),
        'rulesSha256':fingerprint(policy),'reviewedBaselineSha256':review['reviewedBaselineSha256'],
        'reviewedLedgerSha256':review['reviewedLedgerSha256'],
        'reviewedProposalSha256':fingerprint(selected),'decisions':chosen,'adjustments':adjustments,
        'summary':'Deterministic application authorization under user-approved standing rules; source review remains unchanged.'}
    report={'policyId':policy['policyId'],'sourceReviewSha256':origin,
            'supportedObservations':len(chosen),'supportedCorrections':len(adjustments),
            'quarantined':quarantined,'rejected':rejected,'independentReviewPasses':1,
            'legacyPolicyAdoption':legacy}
    return selected,authorization,report


def prepare(run_dir,proposal,review,context):
    path=Path(run_dir)/'legacy-policy-adoption.json'
    adoption=json.loads(path.read_text()) if path.exists() else None
    return select(proposal,review,context,adoption)
