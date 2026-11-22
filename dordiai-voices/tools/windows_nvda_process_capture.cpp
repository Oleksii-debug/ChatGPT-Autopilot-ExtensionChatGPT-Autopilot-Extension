// Separate owned-NVDA sibling-process capture. The accepted marker calibrator
// remains unchanged; its bounded JSON/SHA/format/COM primitives are reused.
#define wmain dordiai_frozen_marker_calibrator_main
#include "windows_process_loopback.cpp"
#undef wmain
#include <tlhelp32.h>

namespace nvda_capture {
static DWORD parent_of(DWORD pid) {
    HANDLE snapshot=CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0);
    if(snapshot==INVALID_HANDLE_VALUE)throw std::runtime_error("Cannot inspect owned process lineage");
    PROCESSENTRY32W row{};row.dwSize=sizeof(row);DWORD parent=0;
    for(BOOL found=Process32FirstW(snapshot,&row);found;found=Process32NextW(snapshot,&row))
        if(row.th32ProcessID==pid){parent=row.th32ParentProcessID;break;}
    CloseHandle(snapshot);if(!parent)throw std::runtime_error("Owned process missing from lineage snapshot");return parent;
}
static bool relationship(DWORD helper,DWORD helper_parent,DWORD target,DWORD target_parent,DWORD controller) {
    return helper&&helper_parent&&target&&controller&&helper!=target&&helper!=controller&&target!=controller&&
           helper_parent==controller&&target_parent==controller;
}
struct HeldProcess {
    HANDLE handle=nullptr;
    explicit HeldProcess(DWORD pid) {
        handle=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,pid);
        if(!handle)throw std::runtime_error("Cannot hold exact owned process instance");
        if(WaitForSingleObject(handle,0)!=WAIT_TIMEOUT){CloseHandle(handle);handle=nullptr;throw std::runtime_error("Owned process already exited");}
    }
    ~HeldProcess(){if(handle)CloseHandle(handle);}
    HeldProcess(const HeldProcess&)=delete;HeldProcess& operator=(const HeldProcess&)=delete;
    void live()const {if(WaitForSingleObject(handle,0)!=WAIT_TIMEOUT)throw std::runtime_error("Owned process exited during bounded capture");}
    std::wstring image()const {wchar_t value[32768];DWORD size=32768;
        if(!QueryFullProcessImageNameW(handle,0,value,&size))throw std::runtime_error("Cannot identify held process image");return {value,size};}
    uint64_t created()const {FILETIME c{},e{},k{},u{};
        if(!GetProcessTimes(handle,&c,&e,&k,&u))throw std::runtime_error("Cannot identify held process creation");
        return ((uint64_t)c.dwHighDateTime<<32)|c.dwLowDateTime;}
};
static unsigned integer(const std::wstring& text,unsigned maximum) {
    if(!std::regex_match(text,std::wregex(L"[0-9]{1,10}")))throw std::runtime_error("Expected bounded decimal integer");
    unsigned long long value=std::stoull(text);if(!value||value>maximum)throw std::runtime_error("Integer exceeds declared bound");return (unsigned)value;
}
static void sha_argument(const std::wstring& value) {
    if(!std::regex_match(value,std::wregex(L"[0-9a-f]{64}")))throw std::runtime_error("Full lowercase SHA256 required");
}
class NvdaCompletion final:public Microsoft::WRL::RuntimeClass<
    Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,Microsoft::WRL::FtmBase,IActivateAudioInterfaceCompletionHandler> {
    HANDLE event_=nullptr;std::mutex mutex_;HRESULT get_=E_PENDING,activate_=E_PENDING;
    ComPtr<IUnknown> interface_;AUDIOCLIENT_ACTIVATION_PARAMS parameters_{};PROPVARIANT activation_{};
public:
    ~NvdaCompletion(){if(event_)CloseHandle(event_);}
    bool initialize(DWORD target){parameters_.ActivationType=AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
        parameters_.ProcessLoopbackParams.TargetProcessId=target;
        parameters_.ProcessLoopbackParams.ProcessLoopbackMode=PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
        activation_.vt=VT_BLOB;activation_.blob.cbSize=sizeof(parameters_);activation_.blob.pBlobData=(BYTE*)&parameters_;
        event_=CreateEventW(nullptr,TRUE,FALSE,nullptr);return event_!=nullptr;}
    PROPVARIANT* parameters(){return &activation_;}HANDLE event()const{return event_;}
    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation)override {
        HRESULT activation=E_UNEXPECTED;ComPtr<IUnknown> value;HRESULT get=operation->GetActivateResult(&activation,&value);
        {std::lock_guard<std::mutex> lock(mutex_);get_=get;activate_=activation;interface_=value;}SetEvent(event_);return S_OK;}
    HRESULT result(HRESULT& get,HRESULT& activation,ComPtr<IAudioClient>& output){std::lock_guard<std::mutex> lock(mutex_);
        get=get_;activation=activate_;if(FAILED(get_))return get_;if(FAILED(activate_))return activate_;
        return interface_?interface_.As(&output):E_POINTER;}
    void clear(){std::lock_guard<std::mutex> lock(mutex_);interface_.Reset();}
};
struct Ownership {DWORD target,controller;fs::path root,config;std::string image_sha,ready_sha;uint64_t target_created,controller_created;};
static std::string ownership_json(const Ownership& own) {
    return object({{"target_pid",std::to_string(own.target)},{"controller_pid",std::to_string(own.controller)},
        {"helper_pid",std::to_string(GetCurrentProcessId())},{"target_parent_pid",std::to_string(own.controller)},
        {"helper_parent_pid",std::to_string(own.controller)},{"same_controller_parent_verified","true"},
        {"held_target_creation_filetime",std::to_string(own.target_created)},
        {"held_controller_creation_filetime",std::to_string(own.controller_created)},
        {"image_sha256",q(own.image_sha)},{"plugin_ready_sha256",q(own.ready_sha)},
        {"owned_run_root",q(utf8(own.root.wstring()))},{"owned_config",q(utf8(own.config.wstring()))},
        {"scope",q("Only held official NVDA sibling launched by this exact controller; no arbitrary or system PID")}});
}
static Bytes capture(const Ownership& own,const Format& format,unsigned seconds,Proof& proof,HeldProcess& target,HeldProcess& controller,const fs::path& output) {
    Bytes captured;ComPtr<IAudioClient> client;ComPtr<IAudioCaptureClient> reader;
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;auto completion=Microsoft::WRL::Make<NvdaCompletion>();
    HANDLE event=nullptr;bool requested=false,callback=false,started=false;
    proof.fields["capture_mode"]=q("verified-owned-nvda-sibling-include-tree");
    proof.fields["scope"]=q("Only held controller-owned official NVDA process tree and known phrase through genuine WavePlayer; no other process audio, microphone or physical/acoustic acceptance");
    proof.fields["helper_child_processes_created"]="false";
    proof.fields["target_descendants_included"]="true";
    proof.fields["child_processes_created_scope"]=q("Capture helper only; owned NVDA target may have its private speech-worker descendants");
    proof.fields["ownership"]=ownership_json(own);proof.fields["target_pid"]=std::to_string(own.target);
    proof.fields["current_pid"]=std::to_string(GetCurrentProcessId());
    proof.fields["native_format"]=format.json();proof.fields["capture_seconds_limit"]=std::to_string(seconds);
    proof.fields["endpoint_format_changed"]="false";proof.fields["stream_format_scope"]=q("Mono PCM16 at unchanged driver sample rate; stream-local capture conversion only");
    try {
        if(!completion||!completion->initialize(own.target))throw std::runtime_error("Cannot allocate owned NVDA callback");
        HRESULT hr=ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,__uuidof(IAudioClient),completion->parameters(),completion.Get(),&operation);
        proof.check(hr,"Activate verified owned NVDA process capture");requested=true;
        DWORD waited=WaitForSingleObject(completion->event(),5000);proof.fields["activation_wait_result"]=std::to_string(waited);
        if(waited!=WAIT_OBJECT_0)throw std::runtime_error("Owned NVDA activation callback watchdog");
        callback=true;HRESULT get=E_PENDING,activation=E_PENDING;hr=completion->result(get,activation,client);
        proof.fields["get_activate_result_hresult"]=q(hexhr(get));proof.fields["activation_hresult"]=q(hexhr(activation));
        proof.check(hr,"Get owned NVDA capture IAudioClient");
        DWORD flags=AUDCLNT_STREAMFLAGS_LOOPBACK|AUDCLNT_STREAMFLAGS_EVENTCALLBACK|AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
        proof.fields["capture_stream_flags"]=std::to_string(flags);
        proof.check(client->Initialize(AUDCLNT_SHAREMODE_SHARED,flags,0,0,(WAVEFORMATEX*)format.raw.data(),nullptr),"Initialize owned NVDA mono stream");
        event=CreateEventW(nullptr,FALSE,FALSE,nullptr);if(!event)throw std::runtime_error("Create owned capture event");
        proof.check(client->SetEventHandle(event),"Set owned capture event");
        proof.check(client->GetService(IID_PPV_ARGS(&reader)),"Get owned NVDA capture reader");
        target.live();controller.live();proof.check(client->Start(),"Start owned NVDA capture");started=true;
        auto ready=object({{"status",q("capture-started")},{"target_pid",std::to_string(own.target)},
            {"controller_pid",std::to_string(own.controller)},{"helper_pid",std::to_string(GetCurrentProcessId())},
            {"ownership",ownership_json(own)},{"sample_rate",std::to_string(format.rate)},
            {"channels","1"},{"bits_per_sample","16"},{"capture_seconds_limit",std::to_string(seconds)}});
        write_bytes(output/L"ready.json",Bytes(ready.begin(),ready.end()));
        auto start=std::chrono::steady_clock::now();size_t maximum=(size_t)format.rate*seconds;
        while(std::chrono::steady_clock::now()-start<std::chrono::seconds(seconds)&&captured.size()/format.align<maximum) {
            target.live();controller.live();UINT32 packet=0;proof.check(reader->GetNextPacketSize(&packet),"Owned NVDA next packet");unsigned drains=0;
            while(packet&&captured.size()/format.align<maximum) {
                if(++drains>1024)throw std::runtime_error("Owned capture packet drain exceeded bound");
                BYTE* data=nullptr;UINT32 count=0;DWORD flags=0;UINT64 position=0,qpc=0;
                HRESULT hr=reader->GetBuffer(&data,&count,&flags,&position,&qpc);if(hr==AUDCLNT_S_BUFFER_EMPTY)break;
                proof.check(hr,"Owned NVDA capture GetBuffer");bool acquired=true;
                try {
                    if(hr!=S_OK||!count||count>384000)throw std::runtime_error("Invalid owned NVDA capture packet");
                    size_t keep=std::min<size_t>(count,maximum-captured.size()/format.align),before=captured.size();captured.resize(before+keep*format.align);
                    if(flags&AUDCLNT_BUFFERFLAGS_SILENT)memset(captured.data()+before,0,keep*format.align);
                    else {if(!data)throw std::runtime_error("Missing owned capture pointer");memcpy(captured.data()+before,data,keep*format.align);}
                    if(proof.packets.size()>=4096)throw std::runtime_error("Owned capture packet metadata exceeded bound");
                    proof.packets.push_back(object({{"frames",std::to_string(count)},{"retained_frames",std::to_string(keep)},
                        {"flags",std::to_string(flags)},{"device_position_frames",std::to_string(position)},
                        {"qpc_position_100ns",std::to_string(qpc)},{"observed_qpc_ticks",std::to_string(perf())}}));
                    hr=reader->ReleaseBuffer(count);acquired=false;proof.check(hr,"Owned capture ReleaseBuffer");
                }catch(...){if(acquired){hr=reader->ReleaseBuffer(count);if(FAILED(hr))proof.cleanup.push_back(q("Owned capture exception ReleaseBuffer "+hexhr(hr)));}throw;}
                proof.check(reader->GetNextPacketSize(&packet),"Owned NVDA next packet");
            }
            DWORD wait=WaitForSingleObject(event,2);if(wait!=WAIT_OBJECT_0&&wait!=WAIT_TIMEOUT)throw std::runtime_error("Owned capture event wait failed");
        }
        if(captured.empty())throw std::runtime_error("No owned NVDA process PCM captured");
        proof.fields["captured_frames"]=std::to_string(captured.size()/format.align);
        proof.fields["captured_bytes"]=std::to_string(captured.size());proof.fields["capture_wall_seconds"]=number(std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count());
        proof.fields["status"]=q("technical-owned-nvda-capture-complete");
    }catch(const std::exception& error){proof.fields["status"]=q("failed");proof.fields["reason"]=q(error.what());}
    if(started){HRESULT hr=client->Stop();if(FAILED(hr))proof.cleanup.push_back(q("Owned NVDA capture Stop "+hexhr(hr)));}
    reader.Reset();client.Reset();if(completion&&callback)completion->clear();operation.Reset();completion.Reset();
    if(event)CloseHandle(event);proof.fields["async_callback_completed"]=callback?"true":"false";
    proof.fields["all_own_com_interfaces_released"]=(!requested||callback)&&proof.cleanup.empty()?"true":"false";
    if(!proof.cleanup.empty())proof.fields["status"]=q("failed");return captured;
}
}

int wmain(int argc,wchar_t** argv) {
    using namespace nvda_capture;bool initialized=false;
    try {
        if(argc==2&&std::wstring(argv[1])==L"--self-test") {
            guard_environment();static_assert(sizeof(WAVEFORMATEX)==18,"Packed audio ABI");
            if(!relationship(3,1,2,1,1)||relationship(3,1,2,4,1)||relationship(3,1,3,1,1)||relationship(3,2,2,2,2))
                throw std::runtime_error("Sibling lineage self-test failed");
            std::cout<<object({{"status",q("owned-sibling-pure-contracts-passed")},{"device_api_called","false"},
                {"audio_capture_started","false"},{"physical_audio_verified","false"}})<<std::endl;return 0;
        }
        std::map<std::wstring,std::wstring> args;
        for(int i=1;i<argc;i++){std::wstring key=argv[i];
            if(key!=L"--owned-nvda-pid"&&key!=L"--controller-pid"&&key!=L"--owned-run-root"&&key!=L"--probe-id"&&key!=L"--nvda-image-sha256"&&key!=L"--plugin-ready-sha256"&&
               key!=L"--sample-rate"&&key!=L"--seconds"&&key!=L"--output"&&key!=L"--owned-instance-id")throw std::runtime_error("Unrecognized guarded NVDA capture argument");
            if(i+1>=argc||args.count(key))throw std::runtime_error("Missing or duplicate guarded argument");args[key]=argv[++i];}
        if(args.size()!=10)throw std::runtime_error("All exact owned-process capture arguments required");
        guard(args.at(L"--owned-instance-id"));
        DWORD target_pid=integer(args.at(L"--owned-nvda-pid"),0xffffffff),controller_pid=integer(args.at(L"--controller-pid"),0xffffffff);
        // Hold both process objects before inspecting lineage, preventing a
        // PID-reuse race from substituting another process after the snapshot.
        HeldProcess target(target_pid),controller(controller_pid);
        DWORD self=GetCurrentProcessId(),parent=parent_of(self);
        if(!relationship(self,parent,target_pid,parent_of(target_pid),controller_pid))throw std::runtime_error("Only controller-owned sibling NVDA process may be captured");
        if(!std::regex_match(args.at(L"--probe-id"),std::wregex(L"[0-9a-f]{32}")))throw std::runtime_error("Owned probe nonce required");
        fs::path root=fs::absolute(args.at(L"--owned-run-root")),output=fs::absolute(args.at(L"--output"));
        no_links(root);no_links(output);owned_file_parent(output,false);
        if(output.parent_path()!=root||output.filename()!=L"process-capture")throw std::runtime_error("Fixed capture child directory required");
        if(root.filename().wstring()!=L"nvda-"+args.at(L"--probe-id"))throw std::runtime_error("Run directory must bind owned nonce");
        fs::path image=root/L"portable"/L"nvda.exe",config=root/L"config",ready=root/L"plugin-ready.json";
        for(const auto& path:{image,config/L"nvda.ini",ready,config/L"addons"/L"dordiaiCaptureProbe"/L"globalPlugins"/L"dordiaiCaptureProbe.py"}){
            no_links(path);if(!fs::is_regular_file(path))throw std::runtime_error("Missing fixed fresh NVDA owned path");}
        sha_argument(args.at(L"--nvda-image-sha256"));sha_argument(args.at(L"--plugin-ready-sha256"));
        if(final_path(target.image())!=final_path(image))throw std::runtime_error("Owned NVDA image path differs");
        std::string image_sha=sha(read_file(image,64*1024*1024)),ready_sha=sha(read_file(ready,65536));
        if(image_sha!=utf8(args.at(L"--nvda-image-sha256"))||ready_sha!=utf8(args.at(L"--plugin-ready-sha256")))throw std::runtime_error("Owned official-image or ready-lease SHA differs");
        unsigned rate=integer(args.at(L"--sample-rate"),48000),seconds=integer(args.at(L"--seconds"),10);
        if((rate!=22050&&rate!=24000&&rate!=48000)||seconds<3)throw std::runtime_error("Only bounded actual driver sample rates and3..10seconds accepted");
        WAVEFORMATEX pcm{};pcm.wFormatTag=WAVE_FORMAT_PCM;pcm.nChannels=1;pcm.nSamplesPerSec=rate;pcm.wBitsPerSample=16;pcm.nBlockAlign=2;pcm.nAvgBytesPerSec=rate*2;
        Format format;format.raw.assign((BYTE*)&pcm,(BYTE*)&pcm+sizeof(pcm));format.bits=16;format.channels=1;format.align=2;format.tag=WAVE_FORMAT_PCM;format.extra=0;format.rate=rate;format.average=rate*2;format.floating=false;
        Ownership own{target_pid,controller_pid,root,config,image_sha,ready_sha,target.created(),controller.created()};
        HRESULT hr=CoInitializeEx(nullptr,COINIT_MULTITHREADED);if(FAILED(hr))throw std::runtime_error("Owned NVDA MTA COM "+hexhr(hr));initialized=true;
        if(!fs::create_directory(output))throw std::runtime_error("Fresh capture output required");
        Proof proof;Bytes captured=capture(own,format,seconds,proof,target,controller,output);
        CoUninitialize();initialized=false;
        if(!captured.empty()){write_bytes(output/L"captured.pcm",captured);proof.fields["captured_pcm"]=receipt("captured.pcm",captured);}
        auto json=proof.json();write_bytes(output/L"capture.json",Bytes(json.begin(),json.end()));
        std::cout<<object({{"status",proof.fields["status"]},{"target_pid",std::to_string(target_pid)},
            {"all_own_com_interfaces_released",proof.fields["all_own_com_interfaces_released"]},{"physical_audio_verified","false"}})<<std::endl;
        return proof.fields["status"]==q("technical-owned-nvda-capture-complete")&&proof.fields["all_own_com_interfaces_released"]=="true"?0:1;
    }catch(const std::exception& error){if(initialized)CoUninitialize();std::cerr<<error.what()<<std::endl;return 1;}
}
