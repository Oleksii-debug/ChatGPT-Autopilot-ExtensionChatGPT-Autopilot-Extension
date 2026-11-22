// Separate local engineering helper. Never call/relax the frozen hosted CLI.
// CI must verify the included source SHA before compiling this translation unit.
#define wmain dordiai_frozen_hosted_main_not_an_entrypoint
#include "windows_process_loopback.cpp"
#undef wmain
#include <thread>
#include <limits>

static constexpr const char* FROZEN_SOURCE_SHA="eba7fd78469298b7c4c300fdd80c9da18ffb1d03323c8b72230d92ff59448012";
static constexpr uint64_t HNS_SECOND=10000000;
static uint64_t local_hns(uint64_t ticks,uint64_t frequency) {
    if(!frequency||frequency>1000000000)throw std::runtime_error("Unsupported QPC frequency");
    auto whole=ticks/frequency,part=(ticks%frequency)*HNS_SECOND/frequency;
    if(whole>(std::numeric_limits<uint64_t>::max()-part)/HNS_SECOND)throw std::runtime_error("QPC overflow");
    return whole*HNS_SECOND+part;
}
static Format local_format(const Bytes& raw) {
    if(raw.size()<sizeof(WAVEFORMATEX))throw std::runtime_error("Short expected native format");
    auto wave=(const WAVEFORMATEX*)raw.data();
    if(wave->cbSize>512||raw.size()!=sizeof(WAVEFORMATEX)+wave->cbSize)throw std::runtime_error("Noncanonical expected format size");
    Format f;f.raw=raw;f.bits=wave->wBitsPerSample;f.channels=wave->nChannels;f.align=wave->nBlockAlign;
    f.tag=wave->wFormatTag;f.extra=wave->cbSize;f.rate=wave->nSamplesPerSec;f.average=wave->nAvgBytesPerSec;
    WORD kind=f.tag;
    if(kind==WAVE_FORMAT_EXTENSIBLE) {
        if(f.extra<22||raw.size()<sizeof(WAVEFORMATEXTENSIBLE))throw std::runtime_error("Short extensible format");
        auto ext=(const WAVEFORMATEXTENSIBLE*)raw.data();
        GUID subtype={1,0,0x10,{0x80,0,0,0xaa,0,0x38,0x9b,0x71}};
        if(IsEqualGUID(ext->SubFormat,subtype))kind=WAVE_FORMAT_PCM;
        else {subtype.Data1=3;if(!IsEqualGUID(ext->SubFormat,subtype))throw std::runtime_error("Unsupported subtype");kind=WAVE_FORMAT_IEEE_FLOAT;}
        if(ext->Samples.wValidBitsPerSample&&ext->Samples.wValidBitsPerSample!=f.bits)throw std::runtime_error("Unsupported valid bits");
    }
    f.floating=kind==WAVE_FORMAT_IEEE_FLOAT&&f.bits==32;
    if((!f.floating&&!(kind==WAVE_FORMAT_PCM&&f.bits==16))||f.channels!=2||f.rate<8000||f.rate>192000||
       f.align!=2*(f.bits/8)||f.average!=f.rate*f.align)throw std::runtime_error("Unsupported bounded unchanged native format");
    return f;
}
static uint64_t local_start_time() {
    FILETIME created{},ended{},kernel{},user{};
    if(!GetProcessTimes(GetCurrentProcess(),&created,&ended,&kernel,&user))throw std::runtime_error("Own process time unavailable");
    return ((uint64_t)created.dwHighDateTime<<32)|created.dwLowDateTime;
}
struct LocalWatchdog {
    HANDLE done=nullptr;std::thread thread;
    LocalWatchdog() {
        done=CreateEventW(nullptr,TRUE,FALSE,nullptr);if(!done)throw std::runtime_error("Watchdog event unavailable");
        thread=std::thread([this]{if(WaitForSingleObject(done,8000)!=WAIT_OBJECT_0)TerminateProcess(GetCurrentProcess(),124);});
    }
    ~LocalWatchdog(){SetEvent(done);thread.join();CloseHandle(done);}
};
static bool local_endpoint_allowed(const std::wstring& id) {
    // The two hardware-backed ACTIVE endpoints in the reviewed local inventory.
    return id==L"{0.0.0.00000000}.{ab77274c-f0dc-481f-9ac9-17587c2edff8}"||
           id==L"{0.0.0.00000000}.{fc1f7846-3543-4cff-aaee-de24d7de09b4}";
}
static std::string local_handshake(const std::wstring& nonce,uint64_t started,const std::string& executable_sha) {
    HANDLE input=GetStdHandle(STD_INPUT_HANDLE);
    if(input==INVALID_HANDLE_VALUE||GetFileType(input)!=FILE_TYPE_PIPE)throw std::runtime_error("Only own parent pipe accepted");
    std::cout<<object({{"format",q("dordiai-owned-clock-ready")},{"nonce",q(utf8(nonce))},
        {"current_pid",std::to_string(GetCurrentProcessId())},{"process_start_filetime",std::to_string(started)},
        {"executable_sha256",q(executable_sha)},{"audio_api_called","false"}})<<std::endl;
    auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(1000);std::string line;
    while(std::chrono::steady_clock::now()<deadline) {
        DWORD available=0;if(!PeekNamedPipe(input,nullptr,0,nullptr,&available,nullptr))throw std::runtime_error("Parent pipe closed");
        if(available) {
            char byte=0;DWORD read=0;if(!ReadFile(input,&byte,1,&read,nullptr)||read!=1)throw std::runtime_error("Parent permit read failed");
            if(byte=='\n')return line;
            if(byte<' '||byte>'~'||line.size()>=256)throw std::runtime_error("Invalid bounded parent permit");
            line.push_back(byte);
        }else Sleep(1);
    }throw std::runtime_error("Parent ownership permit timeout");
}
static Endpoint local_select_endpoint(const std::wstring& id) {
    ComPtr<IMMDeviceEnumerator> enumerator;
    HRESULT hr=CoCreateInstance(__uuidof(MMDeviceEnumerator),nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&enumerator));
    if(FAILED(hr))throw std::runtime_error("Endpoint enumerator "+hexhr(hr));
    Endpoint e;e.id=id;hr=enumerator->GetDevice(id.c_str(),&e.device);
    if(FAILED(hr))throw std::runtime_error("Exact reviewed endpoint unavailable "+hexhr(hr));
    DWORD state=0;hr=e.device->GetState(&state);
    if(FAILED(hr)||state!=DEVICE_STATE_ACTIVE)throw std::runtime_error("Exact reviewed endpoint is not ACTIVE");
    e.name=L"Explicit inventoried hardware endpoint (not selected by default role)";return e;
}
static Bytes local_marker(const Format& f) {
    size_t frames=f.rate/10;Bytes raw(frames*f.align);
    for(size_t i=0;i<frames;i++) {
        double t=(double)i/f.rate,edge=std::min({1.,(double)i/(f.rate*.008),(double)(frames-1-i)/(f.rate*.008)});
        double value=.03*edge*std::sin(6.283185307179586*(600.*t+6000.*t*t));
        for(size_t channel=0;channel<2;channel++) {
            size_t at=i*f.align+channel*(f.bits/8);
            if(f.floating){float v=(float)value;memcpy(raw.data()+at,&v,4);}
            else {int16_t v=(int16_t)std::lround(value*32767.);memcpy(raw.data()+at,&v,2);}
        }
    }return raw;
}
static RunResult local_transport(Endpoint& endpoint,const Format& f) {
    RunResult result;auto& proof=result.proof;result.reference=local_marker(f);
    proof.fields["format"]=q("dordiai-owned-hardware-clock-transport");
    proof.fields["scope"]=q("Own marker process transport; separate render clock and process-tap packet clocks; no NVDA/physical audible acceptance");
    proof.fields["selected_endpoint"]=endpoint.json();proof.fields["native_format"]=f.json();
    proof.fields["marker_duration_ms"]="100";proof.fields["marker_peak_limit"]="0.03";proof.fields["session_limit_ms"]="1500";
    ComPtr<IAudioClient> capture_client,render_client;ComPtr<IAudioCaptureClient> capture;ComPtr<IAudioRenderClient> render;
    ComPtr<IAudioClock> clock;ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    auto completion=Microsoft::WRL::Make<Completion>();bool requested=false,callback=false,rendering=false,capturing=false;
    HANDLE event=nullptr;std::vector<std::string> clocks;size_t offset=0;Bytes readback;
    std::chrono::steady_clock::time_point session_started{};bool session_attempted=false;
    try {
        if(!completion||!completion->initialize())throw std::runtime_error("Completion allocation failed");
        proof.check(ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,__uuidof(IAudioClient),
            completion->activation_parameters(),completion.Get(),&operation),"Activate own-current-process INCLUDE tap");requested=true;
        DWORD waited=WaitForSingleObject(completion->event(),5000);proof.fields["activation_wait_result"]=std::to_string(waited);
        if(waited!=WAIT_OBJECT_0)throw std::runtime_error("Own process activation timeout");callback=true;
        HRESULT get=E_PENDING,activation=E_PENDING;HRESULT qi=completion->result(get,activation,capture_client);
        proof.fields["get_activate_result_hresult"]=q(hexhr(get));proof.fields["activation_hresult"]=q(hexhr(activation));
        proof.check(qi,"Own process activated interface");
        proof.check(endpoint.device->Activate(__uuidof(IAudioClient),CLSCTX_INPROC_SERVER,nullptr,
             (void**)render_client.GetAddressOf()),"Activate exact hardware render");
        if(format_of(render_client.Get()).raw!=f.raw)throw std::runtime_error("Native format differs from parent-reviewed bytes");
        proof.check(render_client->Initialize(AUDCLNT_SHAREMODE_SHARED,0,0,0,(WAVEFORMATEX*)f.raw.data(),nullptr),"Initialize unchanged shared render");
        DWORD flags=AUDCLNT_STREAMFLAGS_LOOPBACK|AUDCLNT_STREAMFLAGS_EVENTCALLBACK|AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
        proof.check(capture_client->Initialize(AUDCLNT_SHAREMODE_SHARED,flags,0,0,(WAVEFORMATEX*)f.raw.data(),nullptr),"Initialize own process tap");
        event=CreateEventW(nullptr,FALSE,FALSE,nullptr);if(!event)throw std::runtime_error("Capture event failed");
        proof.check(capture_client->SetEventHandle(event),"Own capture event");
        proof.check(capture_client->GetService(IID_PPV_ARGS(&capture)),"Own capture service");
        proof.check(render_client->GetService(IID_PPV_ARGS(&render)),"Own render service");
        proof.check(render_client->GetService(IID_PPV_ARGS(&clock)),"Own render IAudioClock");
        UINT64 frequency=0;proof.check(clock->GetFrequency(&frequency),"Own render clock frequency");
        if(!frequency)throw std::runtime_error("Zero render clock frequency");
        proof.fields["render_clock_frequency_device_units_per_second"]=std::to_string(frequency);
        REFERENCE_TIME latency=0;proof.check(render_client->GetStreamLatency(&latency),"Render maximum stream latency");
        if(latency<0)throw std::runtime_error("Negative stream latency");
        proof.fields["render_maximum_stream_latency_100ns"]=std::to_string(latency);
        LARGE_INTEGER qpf{};if(!QueryPerformanceFrequency(&qpf)||qpf.QuadPart<=0)throw std::runtime_error("QPC frequency failed");
        proof.fields["qpc_frequency_ticks_per_second"]=std::to_string(qpf.QuadPart);
        UINT32 capacity=0;proof.check(render_client->GetBufferSize(&capacity),"Own render capacity");
        if(!capacity||capacity>f.rate*2)throw std::runtime_error("Unbounded hardware render capacity");
        proof.fields["render_buffer_frames"]=std::to_string(capacity);
        auto feed=[&](UINT32 frames) {
            BYTE* pointer=nullptr;proof.check(render->GetBuffer(frames,&pointer),"Own render buffer");
            try {
                if(!pointer)throw std::runtime_error("Missing own render buffer");
                size_t size=(size_t)frames*f.align,amount=std::min(size,result.reference.size()-offset);
                memset(pointer,0,size);if(amount)memcpy(pointer,result.reference.data()+offset,amount);
                Bytes observed(pointer,pointer+amount);
                if(amount&&memcmp(observed.data(),result.reference.data()+offset,amount))throw std::runtime_error("Marker readback differs");
                readback.insert(readback.end(),observed.begin(),observed.end());offset+=amount;
            }catch(...){render->ReleaseBuffer(frames,AUDCLNT_BUFFERFLAGS_SILENT);throw;}
            proof.check(render->ReleaseBuffer(frames,0),"Release own render buffer");
        };
        auto observe_clock=[&] {
            UINT64 position=0,qpc=0;uint64_t before=perf();HRESULT hr=clock->GetPosition(&position,&qpc);uint64_t after=perf();
            if(clocks.size()>=4096)throw std::runtime_error("Clock metadata limit");
            clocks.push_back(object({{"hresult",q(hexhr(hr))},{"position_device_units",std::to_string(position)},
                {"api_qpc_100ns",std::to_string(qpc)},{"qpc_before_ticks",std::to_string(before)},{"qpc_after_ticks",std::to_string(after)}}));
            if(FAILED(hr))throw std::runtime_error("Read own render clock "+hexhr(hr));
        };
        feed(capacity);observe_clock();
        auto started=std::chrono::steady_clock::now();session_started=started;session_attempted=true;
        proof.fields["before_capture_start_qpc_ticks"]=std::to_string(perf());
        proof.check(capture_client->Start(),"Start only own process tap");capturing=true;
        proof.fields["before_render_start_qpc_ticks"]=std::to_string(perf());
        proof.check(render_client->Start(),"Start only own marker");rendering=true;
        proof.fields["after_render_start_qpc_ticks"]=std::to_string(perf());
        // Leave100ms for normal Stop/cleanup; audit the real interval, never clamp it.
        while(std::chrono::steady_clock::now()-started<std::chrono::milliseconds(1400)) {
            UINT32 packet=0;proof.check(capture->GetNextPacketSize(&packet),"Own packet size");
            unsigned drained=0;
            while(packet) {
                if(++drained>1024)throw std::runtime_error("Unbounded packet drain");
                BYTE* data=nullptr;UINT32 frames=0;DWORD packet_flags=0;UINT64 position=0,qpc=0;
                uint64_t before=perf();HRESULT hr=capture->GetBuffer(&data,&frames,&packet_flags,&position,&qpc);uint64_t after=perf();
                if(hr==AUDCLNT_S_BUFFER_EMPTY)break;proof.check(hr,"Own capture buffer");
                bool acquired=true;
                try {
                    if(hr!=S_OK||!frames||frames>384000||proof.packets.size()>=4096)throw std::runtime_error("Invalid bounded own packet");
                    size_t bytes=(size_t)frames*f.align;if(result.captured.size()+bytes>8*1024*1024)throw std::runtime_error("Own PCM budget exceeded");
                    size_t at=result.captured.size();result.captured.resize(at+bytes);
                    if(packet_flags&AUDCLNT_BUFFERFLAGS_SILENT)memset(result.captured.data()+at,0,bytes);
                    else {if(!data)throw std::runtime_error("Missing own packet data");memcpy(result.captured.data()+at,data,bytes);}
                    proof.packets.push_back(object({{"frames",std::to_string(frames)},{"flags",std::to_string(packet_flags)},
                        {"device_position_frames",std::to_string(position)},{"api_qpc_100ns",std::to_string(qpc)},
                        {"qpc_before_ticks",std::to_string(before)},{"qpc_after_ticks",std::to_string(after)}}));
                    hr=capture->ReleaseBuffer(frames);acquired=false;proof.check(hr,"Release own capture packet");
                }catch(...){if(acquired)capture->ReleaseBuffer(frames);throw;}
                if(std::chrono::steady_clock::now()-started>=std::chrono::milliseconds(1400))break;
                proof.check(capture->GetNextPacketSize(&packet),"Next own capture packet");
            }
            observe_clock();
            if(std::chrono::steady_clock::now()-started>=std::chrono::milliseconds(1400))break;
            UINT32 padding=0;proof.check(render_client->GetCurrentPadding(&padding),"Own render padding");
            if(padding>capacity)throw std::runtime_error("Invalid own render padding");
            if(capacity>padding)feed(capacity-padding);
            DWORD wait=WaitForSingleObject(event,2);if(wait!=WAIT_TIMEOUT&&wait!=WAIT_OBJECT_0)throw std::runtime_error("Own packet event wait failed");
        }
        proof.fields["session_wall_seconds"]=number(std::chrono::duration<double>(std::chrono::steady_clock::now()-started).count());
        if(readback!=result.reference||result.captured.empty())throw std::runtime_error("Incomplete own marker transport");
        proof.fields["marker_render_readback"]=pcm_facts(readback,f);
        proof.fields["status"]=q("own-marker-transport-complete-clock-quality-not-yet-accepted");
    }catch(const std::exception& e){proof.fields["status"]=q("failed");proof.fields["reason"]=q(e.what());}
    if(rendering){proof.fields["before_render_stop_qpc_ticks"]=std::to_string(perf());HRESULT hr=render_client->Stop();if(FAILED(hr))proof.cleanup.push_back(q("Render Stop "+hexhr(hr)));}
    if(capturing){HRESULT hr=capture_client->Stop();if(FAILED(hr))proof.cleanup.push_back(q("Capture Stop "+hexhr(hr)));}
    if(session_attempted) {
        double seconds=std::chrono::duration<double>(std::chrono::steady_clock::now()-session_started).count();
        proof.fields["session_through_both_stops_seconds"]=number(seconds);
        if(seconds>1.5){proof.fields["status"]=q("failed");proof.fields["reason"]=q("Real own stream session exceeded1500ms; not clamped or accepted");}
    }
    clock.Reset();capture.Reset();render.Reset();capture_client.Reset();render_client.Reset();
    if(completion&&callback)completion->clear();operation.Reset();completion.Reset();if(event)CloseHandle(event);
    proof.fields["render_clock_readings"]=list(clocks);proof.fields["async_callback_completed"]=callback?"true":"false";
    proof.fields["all_own_com_interfaces_released"]=(!requested||callback)&&proof.cleanup.empty()?"true":"false";
    proof.fields["timestamps_replaced_or_improved"]="false";proof.fields["children_created"]="false";
    if(!proof.cleanup.empty())proof.fields["status"]=q("failed");return result;
}
int wmain(int argc,wchar_t** argv) {
    try {
        if(argc==2&&std::wstring(argv[1])==L"--self-test") {
            if(sizeof(void*)!=8||local_hns(7000000,3000000)!=23333333)throw std::runtime_error("Primitive selftest failed");
            auto f=local_format(unhex(L"0300020080bb000000dc0500080020000000"));
            auto marker=local_marker(f);if(marker.size()!=38400)throw std::runtime_error("Marker size selftest failed");
            for(size_t i=0;i<marker.size();i+=4){float sample=0;memcpy(&sample,marker.data()+i,4);if(!std::isfinite(sample)||std::abs(sample)>.030000001f)throw std::runtime_error("Marker peak selftest failed");}
            if(local_endpoint_allowed(L"arbitrary-default"))throw std::runtime_error("Unreviewed endpoint accepted");
            bool bad=false;try{local_format(Bytes{0});}catch(...){bad=true;}if(!bad)throw std::runtime_error("Bad format accepted");
            std::cout<<object({{"status",q("self-test-passed")},{"audio_device_api_called","false"},{"render_started","false"},
                {"capture_started","false"},{"children_created","false"},{"frozen_source_sha256",q(FROZEN_SOURCE_SHA)},{"product_ready","false"}})<<std::endl;return 0;
        }
        std::map<std::wstring,std::wstring> args;
        for(int i=1;i<argc;i+=2) {
            std::wstring key=argv[i];
            if(i+1>=argc||args.count(key)||(key!=L"--mode"&&key!=L"--nonce"&&key!=L"--directory"&&key!=L"--expected-exe-sha256"&&key!=L"--endpoint-id"&&key!=L"--expected-format-hex"))
                throw std::runtime_error("Exact bounded owned arguments only; arbitrary PID/system capture forbidden");
            args[key]=argv[i+1];
        }
        bool describe=args[L"--mode"]==L"describe",run=args[L"--mode"]==L"run";
        if(sizeof(void*)!=8||(!describe&&!run)||args.size()!=(run?6u:5u)||
            !std::regex_match(args[L"--nonce"],std::wregex(L"[0-9a-f]{32}"))||
            !std::regex_match(args[L"--expected-exe-sha256"],std::wregex(L"[0-9a-f]{64}"))||!local_endpoint_allowed(args[L"--endpoint-id"]))
            throw std::runtime_error("Invalid owned mode/nonce/executable/explicit inventoried endpoint");
        // Syntax and bounded format contract are rejected before any COM call.
        Format expected;if(run)expected=local_format(unhex(args[L"--expected-format-hex"]));
        LocalWatchdog watchdog;
        fs::path directory=fs::absolute(args[L"--directory"]);no_links(directory);
        if(final_path(directory)!=L"\\\\?\\d:\\dordiaitesttemp\\owned-clock-"+args[L"--nonce"])
            throw std::runtime_error("Exact fresh nonlinked nonce directory on D required");
        HANDLE held=CreateFileW(directory.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,nullptr);
        if(held==INVALID_HANDLE_VALUE)throw std::runtime_error("Cannot lease own nonce directory");
        struct HandleClose{HANDLE h;~HandleClose(){CloseHandle(h);}} lease{held};
        wchar_t module[32768]{};DWORD size=GetModuleFileNameW(nullptr,module,32768);
        if(!size||size>=32768)throw std::runtime_error("Own executable identity unavailable");
        no_links(module);if(final_path(fs::path(module).parent_path())!=final_path(directory))throw std::runtime_error("Own executable must be inside nonce directory");
        for(const auto& entry:fs::directory_iterator(directory)) {
            if(final_path(entry.path())!=final_path(module)||!entry.is_regular_file())
                throw std::runtime_error("Fresh nonce directory may contain only this exact own executable");
        }
        auto exe_sha=sha(read_file(module,16*1024*1024));if(exe_sha!=utf8(args[L"--expected-exe-sha256"]))throw std::runtime_error("Own executable SHA differs");
        uint64_t started=local_start_time();auto permit=local_handshake(args[L"--nonce"],started,exe_sha);
        auto wanted=utf8(args[L"--nonce"])+"|"+std::to_string(GetCurrentProcessId())+"|"+std::to_string(started)+"|"+exe_sha;
        if(permit!=wanted)throw std::runtime_error("Parent-observed own PID/time/hash permit differs");
        // All ownership, token, endpoint whitelist and expected-format checks precede COM.
        HRESULT hr=CoInitializeEx(nullptr,COINIT_MULTITHREADED);if(FAILED(hr))throw std::runtime_error("Own MTA COM failed");
        struct ComClose{~ComClose(){CoUninitialize();}} com;
        Endpoint endpoint=local_select_endpoint(args[L"--endpoint-id"]);
        if(describe) {
            ComPtr<IAudioClient> client;hr=endpoint.device->Activate(__uuidof(IAudioClient),CLSCTX_INPROC_SERVER,nullptr,(void**)client.GetAddressOf());
            if(FAILED(hr))throw std::runtime_error("Read-only native format activation failed");
            auto format=format_of(client.Get());std::cout<<object({{"status",q("read-only-native-format")},{"native_format",format.json()},
                {"selected_endpoint",endpoint.json()},{"render_started","false"},{"capture_started","false"}})<<std::endl;return 0;
        }
        auto result=local_transport(endpoint,expected);
        result.proof.fields["nonce"]=q(utf8(args[L"--nonce"]));result.proof.fields["process_start_filetime"]=std::to_string(started);
        result.proof.fields["executable_sha256"]=q(exe_sha);result.proof.fields["frozen_source_sha256"]=q(FROZEN_SOURCE_SHA);
        write_bytes(directory/L"reference.pcm",result.reference);write_bytes(directory/L"captured.pcm",result.captured);
        result.proof.fields["reference_pcm"]=receipt("reference.pcm",result.reference);result.proof.fields["captured_pcm"]=receipt("captured.pcm",result.captured);
        auto report=result.proof.json();if(report.size()>1024*1024)throw std::runtime_error("Clock metadata budget exceeded");
        write_bytes(directory/L"clock.json",Bytes(report.begin(),report.end()));
        std::cout<<object({{"status",result.proof.fields["status"]},{"current_pid",std::to_string(GetCurrentProcessId())},
            {"capture_mode",q("process-include-current-pid")},{"physical_audio_verified","false"},{"product_ready","false"}})<<std::endl;
        return result.proof.fields["status"]==q("failed")?1:0;
    }catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}
}
