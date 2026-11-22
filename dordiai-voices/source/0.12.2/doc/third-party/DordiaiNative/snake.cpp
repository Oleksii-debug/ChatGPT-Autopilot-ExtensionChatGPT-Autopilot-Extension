// Fused Holos periodic activation. Same formula and weights; no quantization.
#define ORT_API_MANUAL_INIT
#include "onnxruntime_cxx_api.h"
#include <immintrin.h>
#include <cmath>
#include <mutex>
#include <memory>
#include <vector>
#include <stdexcept>
#include <Eigen/Core>

struct Work {
  const float *x, *a, *b;
  float* y;
  size_t channels, width;
  size_t total;
};
static void row(void* raw, size_t index) {
  const auto& w = *static_cast<const Work*>(raw);
  // Match ORT's Eigen SSE packet sine and global four-element boundaries.
  size_t begin=index*2048, end=std::min(begin+2048,w.total), j=begin;
  while (j+4<=end) {
    size_t channel=(j/w.width)%w.channels;
    size_t boundary=std::min(end,(j/w.width+1)*w.width);
    __m128 ca=_mm_set1_ps(w.a[channel]),cb=_mm_set1_ps(w.b[channel]);
    for (;j+4<=boundary;j+=4) {
      __m128 x=_mm_loadu_ps(w.x+j);
      __m128 s=Eigen::internal::psin(_mm_mul_ps(x,ca));
      _mm_storeu_ps(w.y+j,_mm_add_ps(x,_mm_mul_ps(cb,_mm_mul_ps(s,s))));
    }
    if (j+4>end) break;
    size_t c0=(j/w.width)%w.channels,c1=((j+1)/w.width)%w.channels;
    size_t c2=((j+2)/w.width)%w.channels,c3=((j+3)/w.width)%w.channels;
    __m128 a=_mm_set_ps(w.a[c3],w.a[c2],w.a[c1],w.a[c0]);
    __m128 b=_mm_set_ps(w.b[c3],w.b[c2],w.b[c1],w.b[c0]);
    __m128 x=_mm_loadu_ps(w.x+j);
    __m128 s=Eigen::internal::psin(_mm_mul_ps(x,a));
    _mm_storeu_ps(w.y+j,_mm_add_ps(x,_mm_mul_ps(b,_mm_mul_ps(s,s))));
    j+=4;
  }
  for (;j<end;++j) {
    size_t c=(j/w.width)%w.channels;
    float x=w.x[j],s=std::sin(x*w.a[c]);
    w.y[j]=x+w.b[c]*(s*s);
  }

}
struct Kernel {
  OrtStatusPtr ComputeV2(OrtKernelContext* raw) noexcept {
    try {
      Ort::KernelContext ctx(raw);
      auto x = ctx.GetInput(0), a = ctx.GetInput(1), b = ctx.GetInput(2);
      auto shape = x.GetTensorTypeAndShapeInfo().GetShape();
      if (shape.size()!=3 || shape[0]<1 || shape[1]<1 || shape[2]<1)
        throw std::invalid_argument("DordiaiSnake requires a nonempty B,C,T tensor");
      size_t channels = static_cast<size_t>(shape[1]);
      if (a.GetTensorTypeAndShapeInfo().GetElementCount()!=channels ||
          b.GetTensorTypeAndShapeInfo().GetElementCount()!=channels)
        throw std::invalid_argument("DordiaiSnake channel parameters mismatch");
      auto y = ctx.GetOutput(0,shape);
      Work work{x.GetTensorData<float>(),a.GetTensorData<float>(),b.GetTensorData<float>(),
                y.GetTensorMutableData<float>(),channels,static_cast<size_t>(shape[2]),
                static_cast<size_t>(shape[0]*shape[1]*shape[2])};
      ctx.ParallelFor(row,(work.total+2047)/2048,0,&work);

      return nullptr;
    } catch (const std::exception& e) {
      return Ort::GetApi().CreateStatus(ORT_RUNTIME_EXCEPTION,e.what());
    } catch (...) { return Ort::GetApi().CreateStatus(ORT_RUNTIME_EXCEPTION,"DordiaiSnake failure"); }
  }
};
struct Op : Ort::CustomOpBase<Op,Kernel,true> {
  const char* GetName() const { return "Snake"; }
  size_t GetInputTypeCount() const { return 3; }
  size_t GetOutputTypeCount() const { return 1; }
  ONNXTensorElementDataType GetInputType(size_t) const { return ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT; }
  ONNXTensorElementDataType GetOutputType(size_t) const { return ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT; }
  OrtStatusPtr CreateKernelV2(const OrtApi& api,const OrtKernelInfo*,void** out) const noexcept {
    try { *out = new Kernel; return nullptr; }
    catch (const std::exception& e) { return api.CreateStatus(ORT_RUNTIME_EXCEPTION,e.what()); }
  }
};

extern "C" __declspec(dllexport) OrtStatus* ORT_API_CALL RegisterCustomOps(
    OrtSessionOptions* options,const OrtApiBase* api_base) {
  static std::mutex mutex;
  std::lock_guard<std::mutex> guard(mutex);
  Ort::InitApi(api_base->GetApi(ORT_API_VERSION));
  static Op op;
  static std::vector<std::unique_ptr<Ort::CustomOpDomain>> domains;
  try {
    auto domain = std::make_unique<Ort::CustomOpDomain>("dordiai");
    domain->Add(&op);
    Ort::ThrowOnError(Ort::GetApi().AddCustomOpDomain(options,*domain));
    domains.push_back(std::move(domain));
    return nullptr;
  } catch (const std::exception& e) { return Ort::GetApi().CreateStatus(ORT_RUNTIME_EXCEPTION,e.what()); }
}
