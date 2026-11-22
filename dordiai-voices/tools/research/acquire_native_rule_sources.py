"""Acquire bounded primary native-rule research sources; no inference or redistribution.

Raw documents remain in an owned research cache. The emitted metadata records
actual HTTP failures, first-observed hashes versus prior pins and source rights.
No failed source is replaced by a third-party mirror or a related language.
"""
from __future__ import annotations
import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import tempfile
import urllib.error
import urllib.request

SOURCES=[
 {"id":"tongan-2024-orthography","language":"to","urls":["https://mpia.govt.nz/assets/Resources/Orthography-guidelines/lea-faka-tonga-orthography-guidelines.pdf"],
  "max_bytes":2*1024**2,"kind":"pdf","rights":"Ministry website default CC-BY4 except third-party excerpts/images; source and exceptions retained.",
  "rights_url":"https://mpia.govt.nz/about-us/about-this-site/"},
 {"id":"hiri-motu-1974","language":"ho","urls":["https://openresearch-repository.anu.edu.au/bitstreams/94168cbc-c9e2-4fd0-8541-c764c9385444/download",
   "https://openresearch-repository.anu.edu.au/server/api/core/bitstreams/94168cbc-c9e2-4fd0-8541-c764c9385444/content"],
  "max_bytes":25*1024**2,"kind":"pdf","doi":"10.15144/PL-D24",
  "rights":"PDF footer explicitly online edition CC-BY-SA4; landing metadata also says BY4, preserve conflict and apply conservative SA4 for copied material."},
 {"id":"tetun-official-standard","language":"tet","urls":["https://www.mj.gov.tl/jornal/lawsTL/RDTL-Law/RDTL-Gov-Decrees/Gov-Decree-2004-01.pdf"],
  "max_bytes":2*1024**2,"kind":"pdf","rights":"Official standard identification; no raw-document redistribution licence asserted."},
 {"id":"tetun-native-letter-name-reference","language":"tet","urls":["https://www.lafaek.tl/wp-content/uploads/2023/03/LBM-Ed_1_2017.pdf"],
  "max_bytes":15*1024**2,"kind":"pdf","rights":"CARE magazine expressly restricts copying publication without permission. Keep raw PDF private; independently curate linguistic letter-name facts with attribution, never bulk redistribute the book/song/artwork."},
 {"id":"afar-epitran-map","language":"aa","urls":["https://raw.githubusercontent.com/dmort27/epitran/2387d95820d6d9b8f459c35141e6239f4de5dbfb/epitran/data/map/aar-Latn.csv"],
  "max_bytes":4096,"kind":"csv","expected_bytes":166,"expected_sha256":"b7b6d723ad421d3e3eb85700fb90befeb2cbbecad424d5730bcd2d2f00d0b09e",
  "rights":"MIT implementation; known b→d defect remains unadopted; no complete-prosody claim."},
 {"id":"afar-epitran-license","language":"aa","urls":["https://raw.githubusercontent.com/dmort27/epitran/2387d95820d6d9b8f459c35141e6239f4de5dbfb/LICENSE.txt"],
  "max_bytes":65536,"kind":"txt","rights":"Pinned repository implementation licence; does not license unrelated books/recordings."}
]

def acquire(root,report):
    root=Path(root).absolute();report=Path(report).absolute()
    if root.exists() or root.is_symlink() or report.exists() or report.is_symlink():
        raise FileExistsError("Fresh source cache and immutable receipt required")
    if root==report or root in report.parents or report in root.parents:
        raise ValueError("Receipt and raw-source cache must be disjoint")
    for path in (root,report):
        if any(parent.is_symlink() or getattr(parent,"is_junction",lambda:False)() for parent in path.parents):
            raise ValueError("Linked source/output root forbidden")
    root.mkdir(parents=True)
    doc={"format":"dordiai-primary-native-rule-source-acquisition","format_version":1,"sources":[],
         "raw_documents_redistributed":False,"language_registered":False,"native_pronunciation_verified":False}
    for source in SOURCES:
        row={key:value for key,value in source.items() if key!="urls"}
        row["attempts"]=[];row["acquired"]=False
        for url in source["urls"]:
            descriptor,path=tempfile.mkstemp(prefix=".native-source-",dir=root)
            try:
                digest=sha256();written=0;prefix=b""
                with os.fdopen(descriptor,"wb") as output:
                    request=urllib.request.Request(url,headers={"User-Agent":"Dordiai-native-phonology-research/1.0"})
                    with urllib.request.urlopen(request,timeout=35) as response:
                        if not response.geturl().startswith("https://"):
                            raise ValueError("Primary resource redirected to insecure transport")
                        for block in iter(lambda:response.read(65536),b""):
                            written+=len(block)
                            if written>source["max_bytes"]:raise ValueError("Primary source exceeds declared bound")
                            if len(prefix)<16:prefix=(prefix+block)[:16]
                            digest.update(block);output.write(block)
                if not written:raise ValueError("Empty primary resource")
                if source["kind"]=="pdf" and not prefix.startswith(b"%PDF-"):
                    raise ValueError("Primary URL did not return a PDF")
                actual=digest.hexdigest()
                if "expected_bytes" in source and written!=source["expected_bytes"]:raise ValueError("Pinned size changed")
                if "expected_sha256" in source and actual!=source["expected_sha256"]:raise ValueError("Pinned SHA changed")
                destination=root/(source["id"]+"."+source["kind"])
                os.link(path,destination) # Atomic no-clobber owned publication.
                row.update(acquired=True,url=url,size_bytes=written,sha256=actual,
                    prior_sha256_pin_verified="expected_sha256" in source,
                    hash_provenance="prior reviewed pin" if "expected_sha256" in source else "first observed primary download; not claimed as a prior pin")
                row["attempts"].append({"url":url,"status":"acquired"})
                break
            except (OSError,ValueError) as error:
                row["attempts"].append({"url":url,"status":"failed","error_type":type(error).__name__,
                    "http_status":getattr(error,"code",None),"error":str(error)[:1200]})
            finally:
                if os.path.exists(path):os.unlink(path)
        doc["sources"].append(row)
    doc["status"]="all-primary-sources-acquired" if all(row["acquired"] for row in doc["sources"]) else "partial-primary-acquisition-with-explicit-failures"
    report.parent.mkdir(parents=True,exist_ok=True)
    with report.open("x",encoding="utf-8") as output:json.dump(doc,output,indent=2);output.write("\n")
    print("NATIVE_RULE_SOURCE_ACQUISITION "+json.dumps(doc),flush=True)
    return doc

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache",required=True,type=Path);parser.add_argument("--report",required=True,type=Path)
    args=parser.parse_args();acquire(args.cache,args.report)
    return 0

if __name__=="__main__":raise SystemExit(main())
