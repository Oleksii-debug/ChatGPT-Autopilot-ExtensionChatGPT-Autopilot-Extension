"""Larger exact decoder packets leave more playback time for the next packet."""
from converted_voices import ConvertedVoices

class BufferedConverter(ConvertedVoices):
    def decode_stream(self,spec,source,target,*,step=144):
        yield from super().decode_stream(spec,source,target,step=step)

    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        from threading import Lock
        self.graphics=None
        self._graphics_lock=Lock()
        self._graphics_checked=False

    def warm_graphics(self):
        if self._graphics_checked:return
        with self._graphics_lock:
            if self._graphics_checked:return
            self._graphics_checked=True
            try:
                from radeon_decoder import RadeonDecoder, supported_display
                if supported_display():
                    self.graphics=RadeonDecoder(self)
            except (OSError,AttributeError,RuntimeError):
                self.graphics=None

    def accelerated_blocks(self,spec,source,target):
        graphics=getattr(self,'graphics',None)
        yield from super().decode_stream(spec,source,target,step=144,decoder=graphics)
