"""Private waveform decoder. Only small numeric tensors cross its standard streams."""
from pathlib import Path
import struct
import sys

def read_exact(stream,size):
    data=bytearray(size)
    remaining=memoryview(data)
    while remaining:
        count=stream.readinto(remaining)
        if not count:raise EOFError()
        remaining=remaining[count:]
    return data

def main():
    here=Path(__file__).resolve().parent
    sys.path.insert(0,str(here/'radeon_runtime'))
    import numpy as np
    import onnxruntime as ort
    if 'DmlExecutionProvider' not in ort.get_available_providers():return 1
    ort.disable_telemetry_events()
    options=ort.SessionOptions()
    options.intra_op_num_threads=4
    options.inter_op_num_threads=1
    options.enable_mem_pattern=False
    options.add_session_config_entry('session.intra_op.allow_spinning','0')
    session=ort.InferenceSession(str(here/'models/OpenVoiceV2/decoder-radeon.onnx'),options,
                                 providers=['DmlExecutionProvider','CPUExecutionProvider'])
    if session.get_providers()[0]!='DmlExecutionProvider':return 1
    inp=sys.stdin.buffer
    out=sys.stdout.buffer
    out.write(b'R')
    out.flush()
    while True:
        try:header=read_exact(inp,4)
        except EOFError:return 0
        frames=struct.unpack('<I',header)[0]
        if not 1<=frames<=256:raise ValueError('Invalid decoder frame count')
        latent=np.frombuffer(read_exact(inp,192*frames*4),dtype='<f4').reshape(1,192,frames)
        condition=np.frombuffer(read_exact(inp,256*4),dtype='<f4').reshape(1,256,1)
        wave=session.run(None,{'/Mul_output_0':latent,'/ConstantOfShape_1_output_0':condition})[0]
        if wave.shape!=(1,1,frames*256) or not np.all(np.isfinite(wave)):raise ValueError('Invalid decoder output')
        out.write(wave.tobytes())
        out.flush()

if __name__=='__main__':sys.exit(main())

