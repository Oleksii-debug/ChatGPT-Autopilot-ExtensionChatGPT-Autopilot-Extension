// DESIGN-ONLY self-test. No COM/device/render/capture code exists in this target.
// The existing CI/VB-Cable helper and its guards remain unchanged.
// A future actual-run implementation requires separate root review and source pin.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <cstdint>
#include <limits>
#include <iostream>
#include <stdexcept>
#include <string>

static constexpr uint64_t HNS_PER_SECOND=10000000;
static uint64_t qpc_to_hns(uint64_t ticks,uint64_t frequency) {
    // Bounded arithmetic without ticks*1e7 intermediate overflow. The current
    // Windows QPF is read-only; future experiment rejects unreviewed frequencies.
    if(!frequency||frequency>1000000000)throw std::runtime_error("Unbounded QPC frequency");
    uint64_t whole=ticks/frequency,remainder=ticks%frequency;
    if(whole>std::numeric_limits<uint64_t>::max()/HNS_PER_SECOND)
        throw std::runtime_error("QPC conversion overflow");
    auto base=whole*HNS_PER_SECOND,part=remainder*HNS_PER_SECOND/frequency;
    if(part>std::numeric_limits<uint64_t>::max()-base)throw std::runtime_error("QPC conversion overflow");
    return base+part;
}
int wmain(int argc,wchar_t** argv) {
    // No --run, endpoint, external PID, exclude-tree or capture mode accepted.
    if(argc!=2||std::wstring(argv[1])!=L"--self-test") {
        std::cerr<<"Design only: --self-test required; actual audio run unavailable before root review\n";
        return 2;
    }
    try {
        if(sizeof(void*)!=8||qpc_to_hns(7000000,3000000)!=23333333||qpc_to_hns(0,10000000)!=0)
            throw std::runtime_error("Primitive arithmetic self-test failed");
        bool zero=false,large=false;
        try{qpc_to_hns(1,0);}catch(...){zero=true;}
        try{qpc_to_hns(std::numeric_limits<uint64_t>::max(),1);}catch(...){large=true;}
        if(!zero||!large)throw std::runtime_error("Invalid conversion accepted");
        LARGE_INTEGER ticks{},frequency{};
        if(!QueryPerformanceCounter(&ticks)||!QueryPerformanceFrequency(&frequency)||ticks.QuadPart<0||frequency.QuadPart<=0)
            throw std::runtime_error("Read-only QPC unavailable");
        auto hns=qpc_to_hns((uint64_t)ticks.QuadPart,(uint64_t)frequency.QuadPart);
        std::cout<<"{\"format\":\"dordiai-owned-clock-design-selftest\",\"format_version\":1,"
                 <<"\"status\":\"passed\",\"current_pid\":"<<GetCurrentProcessId()<<","
                 <<"\"raw_qpc_ticks\":"<<ticks.QuadPart<<",\"qpc_frequency\":"<<frequency.QuadPart<<","
                 <<"\"qpc_hns\":"<<hns<<",\"audio_device_api_called\":false,"
                 <<"\"render_started\":false,\"capture_started\":false,\"children_created\":false,"
                 <<"\"actual_run_implemented\":false,\"physical_audio_verified\":false,\"product_ready\":false}\n";
        return 0;
    }catch(const std::exception& error){std::cerr<<error.what()<<"\n";return 1;}
}
