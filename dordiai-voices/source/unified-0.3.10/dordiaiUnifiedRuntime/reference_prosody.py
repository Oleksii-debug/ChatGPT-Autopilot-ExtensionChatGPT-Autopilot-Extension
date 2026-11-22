"""Restore measured reference pitch and excursion before waveform synthesis."""
import numpy as np

class ReferenceProsody:
    def __init__(self,session,profiles):
        self.session=session
        self.profiles=profiles

    def __getattr__(self,key):
        return getattr(self.session,key)

    def run(self,outputs,inputs):
        result=self.session.run(outputs,inputs)
        settings=self.profiles.get(inputs['voice'].tobytes())
        if not settings:
            return result
        f0,energy=result
        center=float(settings['center_hz'])
        scale=float(settings['pitch_scale'])
        excursion=float(settings['excursion'])
        if not 60<=center<=550 or not .75<=scale<=1.35 or not .8<=excursion<=1.8:
            raise ValueError('Invalid reference prosody calibration')
        voiced=np.isfinite(f0)&(f0>=50)
        adjusted=f0.copy()
        adjusted[voiced]=np.clip(center*scale*np.exp(excursion*np.log(f0[voiced]/center)),40,1000)
        return adjusted.astype(np.float32,copy=False),energy
