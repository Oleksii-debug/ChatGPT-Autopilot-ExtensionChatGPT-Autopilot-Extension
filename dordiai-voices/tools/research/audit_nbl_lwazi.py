"""Read-only, pinned Southern Ndebele corpus structure audit; never trains a model.

All hours labelled eligible are mechanical checks, not listening/consent clearance.
Nothing is extracted, and identifying questionnaire/consent contents are not emitted.
Synthetic unit fixtures are deliberately independent of the real-source hash gates.
"""
from __future__ import annotations

import argparse
from collections import Counter
from hashlib import md5, sha256
import io
import json
import math
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import unicodedata
import wave
import zipfile

PINS = {
    'lwazi1': dict(name='tts.lwazi.nbl.1.2.zip', size_bytes=70228518,
                   sha256='8a657adfd0ccdbc493d017afd1c9fc1af1c612177bb6c7ef863665ca533b5f2e',
                   md5='9b87650b2bf5e8791e14ccb6d43a194d',
                   url='https://repo.sadilar.org/server/api/core/bitstreams/df92e046-b8be-4e30-b925-9fc950490a18/content'),
    'lwazi2': dict(name='lwazi_ii_isindebele_tts_corpus.zip', size_bytes=236594963,
                   sha256='36e3f72aef72bf00244c415761892d8cd40bfd828989e884e20fb1fb6182fef3',
                   md5='deab4ce45a7a578c74d0060db37a4b99',
                   url='https://repo.sadilar.org/server/api/core/bitstreams/c8cca8d4-1e74-42c9-bcce-e520a2188665/content'),
    'pronunciation': dict(name='nchlt.speech.pronunciation.dictionaries.zip', size_bytes=1197143,
                   sha256='96c7b5f9c220eb51f3bbff552596255ce6a9175dd489166f829ef6a4484f2215',
                   md5='5b158192a366243bf4cbce40c1248bc1',
                   url='https://repo.sadilar.org/server/api/core/bitstreams/a0749c49-e54d-4d43-b2e2-628f8b82c0ad/content')}
TRANSCRIPT = re.compile(r'^\(\s*((?:data|eng)_\d+)\s+"(.*)"\s*\)\s*$')
ITEM = re.compile(r'^\s*item \[\d+\]:\s*$', re.M)
# The publisher's free-text tier occasionally has literal unescaped interior
# quotes. Read one bounded line literally; never interpret it as executable code
# or silently describe that tier as standards-compliant Praat serialization.
INTERVAL = re.compile(r'^\s*intervals \[\d+\]:\s*\n\s*xmin = ([^\n]+)\n\s*xmax = ([^\n]+)\n\s*text = "([^\n]*)"\s*$', re.M)
SILENCE = {'', '#', '#_cl', 'pau', 'sil', 'sp'}


def fingerprint(path):
    h, m, size = sha256(), md5(), 0
    with Path(path).open('rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            size += len(b); h.update(b); m.update(b)
    return dict(size_bytes=size, sha256=h.hexdigest(), md5=m.hexdigest())


def verify(path, kind):
    got = fingerprint(path)
    if any(got[k] != PINS[kind][k] for k in got):
        raise ValueError('Source differs from exact publisher-MD5/locally-SHA256 pin: ' + kind)
    return dict(PINS[kind], **got)


def checked_members(z):
    members = {}
    total = 0
    for item in z.infolist():
        p = PurePosixPath(item.filename)
        if (not item.filename or p.is_absolute() or '\\' in item.filename
                or any(x in {'', '.', '..'} for x in item.filename.rstrip('/').split('/'))
                or ':' in item.filename or '\x00' in item.filename
                or item.filename in members or stat.S_ISLNK(item.external_attr >> 16)
                or item.flag_bits & 1 or item.file_size > 16 * 1024 * 1024):
            raise ValueError('Unsafe, duplicate, encrypted or oversized archive member')
        total += item.file_size
        if total > 600 * 1024 * 1024 or len(members) >= 20000:
            raise ValueError('Archive exceeds bounded audit budget')
        members[item.filename] = item
    return members


def transcripts(raw):
    rows = {}
    for line in raw.decode('utf-8-sig').splitlines():
        if not line.strip():
            continue
        m = TRANSCRIPT.fullmatch(line)
        if not m or m[1] in rows or not m[2].strip():
            raise ValueError('Invalid/duplicate orthographic transcription')
        rows[m[1]] = unicodedata.normalize('NFC', m[2]).strip()
    return rows


def tiers(raw):
    result = {}
    for block in ITEM.split(raw.decode('utf-8-sig'))[1:]:
        name = re.search(r'^\s*name = "([^"]+)"\s*$', block, re.M)
        expected = re.search(r'^\s*intervals: size = (\d+)\s*$', block, re.M)
        if not name or not expected or name[1] in result:
            raise ValueError('Unsupported/duplicate TextGrid tier')
        rows = [(float(a), float(b), c.replace('""', '"')) for a, b, c in INTERVAL.findall(block)]
        if len(rows) != int(expected[1]):
            raise ValueError('TextGrid interval count mismatch')
        previous = 0.0
        for a, b, _ in rows:
            if not math.isfinite(a) or not math.isfinite(b) or a < 0 or b < a or a + 1e-8 < previous:
                raise ValueError('Nonfinite/reversed/overlapping TextGrid interval')
            previous = b
        result[name[1]] = rows
    if not {'word', 'segment'} <= result.keys():
        raise ValueError('Required real phone and word alignments missing')
    return result


def canonical(text):
    return ' '.join(unicodedata.normalize('NFC', text).casefold().split())


def word_sequence(text):
    return ' '.join(''.join(c if c.isalpha() or unicodedata.category(c).startswith('M') else ' '
                          for c in unicodedata.normalize('NFC', text).casefold()).split())


def prospective_partition(rows):
    # Utterance word-sequence groups, not a claim of unseen individual words,
    # speaker holdout or absence from the original published model's training.
    groups = {}
    for row in rows:
        if row['mechanically_eligible']:
            groups.setdefault(row['split_key'], []).append(row)
    result = {k:dict(groups=0, utterances=0, seconds=0) for k in ['train','validation','test']}
    for key, values in groups.items():
        bucket = int.from_bytes(sha256(('dordiai-nbl-prospective-v1\0'+key).encode('utf-8')).digest()[:4], 'big') % 10
        part = 'train' if bucket < 8 else 'validation' if bucket == 8 else 'test'
        result[part]['groups'] += 1
        result[part]['utterances'] += len(values)
        result[part]['seconds'] += sum(v['seconds'] for v in values)
    return dict(method='SHA256(dordiai-nbl-prospective-v1+NUL+NFC casefold Unicode letter/mark word sequence), first32bits big endian modulo10:0..7 train,8 validation,9 test',
                distinct_native_word_sequence_groups=len(groups), partition=result,
                training_executed=False, not_a_training_manifest=True,
                scope='Prospective text-group partition; no individual-word, speaker or pretrained-base independence claim.')


def audit_tts(path):
    """Return aggregate audit and private comparison rows; no training manifest output."""
    with zipfile.ZipFile(path) as z:
        members = checked_members(z)
        transcript_paths = [n for n in members if n.endswith('/utts.data') or PurePosixPath(n).name == 'transcriptions']
        if len(transcript_paths) != 1:
            raise ValueError('Expected one source transcription list')
        texts = transcripts(z.read(transcript_paths[0]))
        wavs, grids = {}, {}
        for n in members:
            p = PurePosixPath(n)
            target = wavs if p.suffix.lower() == '.wav' else grids if p.suffix.lower() == '.textgrid' else None
            if target is not None:
                if p.stem in target:
                    raise ValueError('Ambiguous file ID')
                target[p.stem] = n
        if texts.keys() != wavs.keys() or texts.keys() != grids.keys():
            raise ValueError('Orthographic/audio/alignment IDs are not exactly paired')
        reasons, formats, phone_counts, eligible_phone_counts = Counter(), Counter(), Counter(), Counter()
        unescaped_quotes = 0
        seconds = frames = eligible_seconds = eligible = 0
        rows, metadata = [], []
        for ident, text in sorted(texts.items()):
            data = z.read(wavs[ident])  # reads complete bytes, verifying the ZIP CRC
            grid_raw = z.read(grids[ident])
            grid = tiers(grid_raw)
            for line in grid_raw.decode('utf-8-sig').splitlines():
                if re.match(r'^\s*text = "', line):
                    interior = line.strip()[8:-1]
                    if '"' in interior.replace('""', ''): unescaped_quotes += 1
            with wave.open(io.BytesIO(data), 'rb') as w:
                fmt = (w.getframerate(), w.getsampwidth(), w.getnchannels(), w.getcomptype())
                count = w.getnframes(); pcm = w.readframes(count)
            if fmt != (16000, 2, 1, 'NONE') or len(pcm) != count * 2:
                raise ValueError('Unexpected or truncated native PCM source')
            formats[str(fmt)] += 1
            duration = count / 16000
            frames += count; seconds += duration
            phonemes = [c for _, _, c in grid['segment'] if c not in SILENCE]
            phone_counts.update(phonemes)
            bad = []
            if not 1 <= duration <= 30: bad.append('outside_1_30_seconds')
            if not any(pcm): bad.append('all_zero_pcm')
            if any(unicodedata.category(c).startswith('N') for c in text): bad.append('number_in_transcript')
            if '|' in text or ident.startswith('eng_'): bad.append('publisher_marked_English_word')
            if not phonemes or not any(c not in SILENCE for _, _, c in grid['word']): bad.append('empty_phone_or_word_alignment')
            if any(end > duration + 0.02 for tier in grid.values() for _, end, _ in tier): bad.append('alignment_exceeds_audio_20ms')
            for reason in bad: reasons[reason] += 1
            accepted = not bad
            if accepted:
                eligible += 1; eligible_seconds += duration
                eligible_phone_counts.update(phonemes)
            rows.append(dict(id=ident, text_key=canonical(text), split_key=word_sequence(text), pcm_sha256=sha256(pcm).hexdigest(),
                             text_sha256=sha256(text.encode()).hexdigest(), seconds=duration,
                             mechanically_eligible=accepted, reasons=bad,
                             original_wave_sha256=sha256(data).hexdigest()))
        for name, info in members.items():
            if info.is_dir() or name in wavs.values() or name in grids.values(): continue
            b = z.read(name)
            record = dict(path=name, size_bytes=len(b), sha256=sha256(b).hexdigest())
            if PurePosixPath(name).name.lower() in {'license.txt', 'licence.txt', 'readme', 'readme.txt'}:
                record['text'] = b.decode('utf-8')
            else: record['contents_not_republished'] = True
            metadata.append(record)
        return dict(paired_utterances=len(rows), pcm_frames=frames, seconds=seconds,
                    hours=seconds / 3600, format_counts=dict(formats),
                    mechanically_eligible_utterances=eligible,
                    mechanically_eligible_seconds=eligible_seconds,
                    mechanically_eligible_hours=eligible_seconds / 3600,
                    rejection_reason_counts=dict(reasons),
                    segment_labels=dict(sorted(phone_counts.items())),
                    eligible_native_segment_labels=dict(sorted(eligible_phone_counts.items())),
                    metadata_files=metadata,
                    textgrid_literal_unescaped_quote_lines=unescaped_quotes,
                    textgrid_note='Bounded per-line literal parser tolerates publisher free-text interior quotes; a canonical Praat rewrite would need explicit preparation.',
                    speaker_id_count_not_inferred_from_filenames=True,
                    scope='Structural CRC/PCM/text/alignment checks only; native pronunciation, consent clearance and model training are not proved.'), rows


def audit_dictionary(path):
    with zipfile.ZipFile(path) as z:
        checked_members(z)
        source = 'release/dictionaries/nchlt_nbl.dict'
        raw = z.read(source); rows = raw.decode('utf-8').splitlines()
        words, phones = set(), Counter()
        for line in rows:
            parts = line.split('\t')
            if len(parts) != 2 or not parts[0] or not parts[1].split():
                raise ValueError('Malformed original nbl dictionary')
            words.add(canonical(parts[0])); phones.update(parts[1].split())
        rule_names = ['release/rules/nchlt_nbl.' + x for x in ['rules','gnulls','map.graphs','map.phones']]
        return dict(source_path=source, entries=len(rows), distinct_normalized_words=len(words),
                    source_sha256=sha256(raw).hexdigest(), xsampa_phone_counts=dict(sorted(phones.items())),
                    exact_native_rules={n: dict(size_bytes=len(z.read(n)), sha256=sha256(z.read(n)).hexdigest()) for n in rule_names},
                    license_text=z.read('LICENSE.txt').decode('utf-8'),
                    scope='Native nbl broad-phonemic dictionary/rules, not ordinary spoken letter names or an acoustic model.')


def run(paths):
    report = dict(format='dordiai-nbl-lwazi-feasibility-audit', format_version=1,
                  language={'iso639_1':'nr','iso639_3':'nbl','name':'Southern Ndebele / isiNdebele',
                            'not_aliases':['nd','nde']}, status='source-audited-not-trained',
                  production_changed=False, training_executed=False, native_readiness=False,
                  source_files={k:verify(p,k) for k,p in paths.items()})
    private = {}
    for kind in ['lwazi1','lwazi2']:
        report[kind],private[kind]=audit_tts(paths[kind])
    report['pronunciation']=audit_dictionary(paths['pronunciation'])
    a,b=private['lwazi1'],private['lwazi2']
    report['cross_corpus_overlap']={
        'distinct_identical_normalized_transcripts':len({x['text_key'] for x in a}&{x['text_key'] for x in b}),
        'distinct_identical_pcm_hashes':len({x['pcm_sha256'] for x in a}&{x['pcm_sha256'] for x in b}),
        'warning':'No conclusion about distinct speakers is drawn from differing PCM or filenames.'}
    report['lwazi2_prospective_partition']=prospective_partition(private['lwazi2'])
    report['utterance_audit']={k:[{a:b for a,b in x.items() if a not in {'text_key','split_key'}} for x in v] for k,v in private.items()}
    # A corpus replaced during the audit must not receive a receipt pinned only
    # to the earlier file; all original immutable archive hashes must still match.
    for kind, path in paths.items():verify(path,kind)
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in PINS:p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--report',type=Path,required=True);a=p.parse_args()
    inputs={k:getattr(a,k).resolve(strict=True) for k in PINS}
    if a.report.is_symlink() or a.report.exists() or a.report.resolve() in inputs.values():
        p.error('Report must be a new output distinct from all source archives')
    result=run(inputs)
    result['auditor_source_sha256']=sha256(Path(__file__).read_bytes()).hexdigest()
    encoded=(json.dumps(result,ensure_ascii=False,indent=2)+'\n').encode('utf-8')
    with a.report.open('xb') as f:f.write(encoded)
    print(json.dumps({k:{n:v for n,v in result[k].items() if n in {'paired_utterances','hours','mechanically_eligible_utterances','mechanically_eligible_hours'}} for k in ['lwazi1','lwazi2']},ensure_ascii=False))
    return 0


if __name__=='__main__':raise SystemExit(main())
