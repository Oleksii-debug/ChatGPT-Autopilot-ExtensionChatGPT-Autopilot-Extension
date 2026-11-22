"""Bounded, fixed-offset software transport analysis; no physical audio claims."""
from __future__ import annotations
import hashlib
import math

SAMPLE_RATES = (22050, 24000, 48000)
MAX_SECONDS = 90
MAX_REFERENCE_SECONDS = 80
MAX_PACKETS = 32768
MAX_PCM_BYTES = 2 * 48000 * MAX_SECONDS
MIN_NCC = .98


def pcm(raw, rate, seconds=MAX_SECONDS):
    import numpy as np
    if rate not in SAMPLE_RATES or not raw or len(raw) % 2 or len(raw) > min(MAX_PCM_BYTES, rate*2*seconds):
        raise ValueError("Bounded actual mono PCM16 at recognized driver rate required")
    return np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.


def ncc_windows(reference, signal):
    """All COMPLETE reference windows; never truncate, warp or resample."""
    import numpy as np
    n,m=len(reference),len(signal)
    if n<2 or m<n:raise ValueError("Complete nontrivial reference must fit captured stream")
    centered=reference-reference.mean(); energy=float(np.dot(centered,centered))
    if energy<=1e-12:raise ValueError("Reference has no variation")
    fft=1 << (n+m-2).bit_length()
    dots=np.fft.irfft(np.fft.rfft(signal,fft)*np.fft.rfft(centered[::-1],fft),fft)[n-1:m]
    sums=np.concatenate(([0.],np.cumsum(signal))); squares=np.concatenate(([0.],np.cumsum(signal*signal)))
    energies=np.maximum(0.,squares[n:]-squares[:-n]-(sums[n:]-sums[:-n])**2/n)
    denominators=np.sqrt(energies*energy)
    values=np.divide(dots,denominators,out=np.zeros_like(dots),where=denominators>1e-15)
    return np.clip(values,-1.,1.), dots/energy


def packet_integrity(packets, captured_frames, rate):
    if rate not in SAMPLE_RATES or not isinstance(packets,list) or not 1<=len(packets)<=MAX_PACKETS:
        raise ValueError("Bounded real capture packet metadata required")
    total=0;previous=None;issues=[]
    for index,row in enumerate(packets):
        for key in ("frames","retained_frames","flags","device_position_frames","qpc_position_100ns"):
            if type(row.get(key)) is not int or row[key]<0:raise ValueError("Invalid native packet integer: "+key)
        frames,keep=row["frames"],row["retained_frames"]
        if not 0<keep<=frames<=384000 or (keep!=frames and index!=len(packets)-1):
            raise ValueError("Only final bounded packet may be trimmed")
        if row["flags"]&4 or (index and row["flags"]&1):issues.append({"packet":index,"reason":"discontinuity-or-timestamp-error"})
        if row["flags"]&~7:issues.append({"packet":index,"reason":"unknown-buffer-flags"})
        if previous is not None:
            if row["device_position_frames"]!=previous["device_position_frames"]+previous["frames"]:
                issues.append({"packet":index,"reason":"device-position-not-contiguous"})
            elapsed=(row["qpc_position_100ns"]-previous["qpc_position_100ns"])*rate/10_000_000
            if abs(elapsed-previous["frames"])>max(2,rate*.002):
                issues.append({"packet":index,"reason":"packet-clock-or-position-ambiguity"})
        total+=keep;previous=row
    if total!=captured_frames:raise ValueError("Packet receipt does not account for every retained frame")
    return {"packet_count":len(packets),"retained_frames":total,"continuous":not issues,
            "issues":issues[:100],"initial_discontinuity_not_used_as_read_gap":bool(packets[0]["flags"]&1)}


def analyze_longread(reference_raw,captured_raw,rate,packets):
    import numpy as np
    reference=pcm(reference_raw,rate,MAX_REFERENCE_SECONDS);signal=pcm(captured_raw,rate)
    if len(reference)<rate:raise ValueError("Longread must contain at least one second of actual reference")
    integrity=packet_integrity(packets,len(signal),rate)
    values,gains=ncc_windows(reference,signal);offset=int(np.argmax(values));coefficient=float(values[offset]);gain=float(gains[offset])
    complete=coefficient>=MIN_NCC and gain>0
    # Lag diagnostics are independent evidence, NEVER a fitted correction to NCC.
    width=rate;hop=rate//2;search=max(2,int(rate*.060));exclusion=max(2,int(rate*.002))
    anchors=[]
    for start in range(0,len(reference)-width+1,hop):
        anchor=reference[start:start+width];energy=float(np.sqrt(np.mean((anchor-anchor.mean())**2)))
        if energy<256/32768:continue
        left=max(0,offset+start-search);right=min(len(signal),offset+start+search+width)
        v,_=ncc_windows(anchor,signal[left:right]);best=int(np.argmax(v));actual=left+best
        competitors=v.copy();competitors[max(0,best-exclusion):min(len(v),best+exclusion+1)]=-1
        second=float(np.max(competitors)) if len(competitors) else -1.
        unique=float(v[best])-second>=.02
        confident=float(v[best])>=MIN_NCC and unique
        anchors.append({"reference_frame":start,"capture_frame":actual,"lag_from_global_frames":actual-(offset+start),
            "ncc":float(v[best]),"competing_peak_ncc":second,"confident_unique":confident})
    stable=bool(anchors) and all(a["confident_unique"] and abs(a["lag_from_global_frames"])<=1 for a in anchors)
    aligned=signal[offset:offset+len(reference)];window=max(1,int(rate*.020));step=max(1,int(rate*.005));drops=[]
    def rms_windows(x):
        summed=np.concatenate(([0.],np.cumsum(x*x)))
        positions=np.arange(0,len(x)-window+1,step)
        return positions,np.sqrt(np.maximum(0.,(summed[positions+window]-summed[positions])/window))
    positions,expected=rms_windows(reference*max(gain,0));_,observed=rms_windows(aligned)
    mask=(expected>=256/32768)&(observed<=np.maximum(2/32768,expected*.02))
    for i in np.flatnonzero(mask)[:100]:drops.append({"reference_frame":int(positions[i]),"window_frames":window,
        "expected_rms":float(expected[i]),"observed_rms":float(observed[i])})
    gap=complete and integrity["continuous"] and stable and not drops
    return {"format":"dordiai-bounded-real-nvda-longread-analysis","format_version":1,
        "complete_reference_window_used":True,"dynamic_warp_or_resampling_used":False,"ncc_threshold":MIN_NCC,
        "normalized_correlation":coefficient,"least_squares_gain":gain,"fixed_offset_frames":offset,
        "offset_scope":"Retained software array offset; not acoustic or startup latency",
        "reference_frames":len(reference),"captured_frames":len(signal),"sample_rate":rate,
        "reference_sha256":hashlib.sha256(reference_raw).hexdigest(),"captured_sha256":hashlib.sha256(captured_raw).hexdigest(),
        "full_reference_transport_verified":complete,"packet_integrity":integrity,"anchors":anchors,
        "all_active_anchors_unique_and_stable_within_one_sample":stable,"active_drop_minimum_ms":20,
        "active_drop_windows":drops,"no_new_transport_gap_verified":gap,
        "gap_gate_status":"passed" if gap else "open-clock-or-anchor-ambiguity" if complete and not drops else "failed",
        "natural_reference_pauses_excluded":True,"feed_waits_not_interpreted_as_cpu_stalls":True,
        "physical_audio_verified":False,"acoustic_latency_verified":False,"native_pronunciation_verified":False,"product_ready":False}


def cancellation_tail(captured_raw,rate,packets,clock):
    """Map actual software packet timestamps to a bracketed own-process cancel.

    Returns an interval, never a point estimate or acoustic claim. A timestamp
    error or missing calibrated bracket leaves this independent gate open.
    """
    import numpy as np
    signal=pcm(captured_raw,rate,10);integrity=packet_integrity(packets,len(signal),rate)
    required=("qpc_frequency","qpc_before_cancel","qpc_after_cancel","perf_before_cancel_ns","perf_after_cancel_ns")
    if any(type(clock.get(k)) is not int or clock[k]<0 for k in required):raise ValueError("Exact bounded cancellation clock bracket required")
    frequency=clock["qpc_frequency"];before=clock["qpc_before_cancel"];after=clock["qpc_after_cancel"]
    if not frequency or after<before or clock["perf_after_cancel_ns"]<clock["perf_before_cancel_ns"]:
        raise ValueError("Cancellation clock is not monotonic")
    result={"format":"dordiai-real-nvda-software-cancel-tail","packet_integrity":integrity,
        "public_cancel_api":"speech.cancelSpeech","physical_audio_verified":False,"acoustic_latency_verified":False,
        "software_tail_interval_ms":None,"gate_status":"open","clock_bracket":clock}
    # Each retained packet maps its first actual sample to its own native QPC.
    # Do not infer time from Python feed-call return or an array offset.
    cancel_low=before*10_000_000/frequency;cancel_high=after*10_000_000/frequency
    offset=0;last=None;active_before=False;capture_end=None
    window=max(1,int(rate*.010))
    for row in packets:
        chunk=signal[offset:offset+row["retained_frames"]];offset+=len(chunk)
        for first in range(0,len(chunk),window):
            piece=chunk[first:first+window]
            if not len(piece):continue
            low=row["qpc_position_100ns"]+first*10_000_000/rate
            high=low+len(piece)*10_000_000/rate
            if float(np.sqrt(np.mean(piece*piece)))>2/32768:
                last=(low,high)
                if high<cancel_low:active_before=True
        capture_end=row["qpc_position_100ns"]+row["retained_frames"]*10_000_000/rate
    # Full preceding speech and >=500ms post-cancel observation are mandatory.
    clock_ok=integrity["continuous"] and not any(r["flags"]&4 for r in packets)
    if clock_ok and active_before and last and capture_end is not None and capture_end-max(cancel_high,last[1])>=5_000_000:
        result.update(gate_status="measured-software-only",software_tail_interval_ms=[
            max(0.,(last[0]-cancel_high)/10000),max(0.,(last[1]-cancel_low)/10000)],
            sustained_silence_observed_ms=(capture_end-max(cancel_high,last[1]))/10000,
            no_resumption_in_retained_observation=True,threshold_pcm_lsb=2,rms_window_ms=10,packet_remainders_examined=True)
    return result
