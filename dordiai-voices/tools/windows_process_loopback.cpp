// Isolated CI calibration using documented own-process ApplicationLoopback.
// No driver/default/privacy/volume/security settings are changed. No child processes.
// Primary API flow: Microsoft's Windows-classic-samples/Samples/ApplicationLoopback.
#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propvarutil.h>
#include <propsys.h>
#include <mmreg.h>
#include <cfgmgr32.h>
#include <bcrypt.h>
#include <wrl/client.h>
#include <wrl/implements.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <mutex>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#pragma comment(lib,"ole32.lib")
#pragma comment(lib,"propsys.lib")
#pragma comment(lib,"mmdevapi.lib")
#pragma comment(lib,"cfgmgr32.lib")
#pragma comment(lib,"bcrypt.lib")
using Microsoft::WRL::ComPtr;
namespace fs=std::filesystem;
using Bytes=std::vector<BYTE>;
static const wchar_t* REPO=L"Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension";
static std::string utf8(const std::wstring& text) {
    if(text.empty())return {};
    int size=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.data(),(int)text.size(),nullptr,0,nullptr,nullptr);
    if(!size)throw std::runtime_error("Invalid Unicode");
    std::string result(size,'\0');
    WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.data(),(int)text.size(),result.data(),size,nullptr,nullptr);
    return result;
}
static std::wstring lower(std::wstring text) {
    std::transform(text.begin(),text.end(),text.begin(),[](wchar_t c){return (wchar_t)towlower(c);});return text;
}
static std::string q(const std::string& s) {
    std::ostringstream out;out<<'"';
    for(unsigned char c:s) {switch(c) {
        case '"':out<<"\\\"";break;case '\\':out<<"\\\\";break;case '\n':out<<"\\n";break;
        case '\r':out<<"\\r";break;case '\t':out<<"\\t";break;
        default:if(c<32)out<<"\\u"<<std::hex<<std::setw(4)<<std::setfill('0')<<(unsigned)c<<std::dec;else out<<c;
    }}out<<'"';return out.str();
}
static std::string hexhr(HRESULT hr) {
    std::ostringstream out;out<<"0x"<<std::hex<<std::setw(8)<<std::setfill('0')<<(uint32_t)hr;return out.str();
}
static std::string object(const std::map<std::string,std::string>& fields) {
    std::string out="{";bool first=true;for(auto& pair:fields){if(!first)out+=",";first=false;out+=q(pair.first)+":"+pair.second;}return out+"}";
}
static std::string list(const std::vector<std::string>& rows) {
    std::string out="[";for(size_t i=0;i<rows.size();i++){if(i)out+=",";out+=rows[i];}return out+"]";
}
static std::string number(double value) {
    if(!std::isfinite(value))throw std::runtime_error("Nonfinite JSON number");
    std::ostringstream out;out<<std::setprecision(17)<<value;return out.str();
}
static std::string bytehex(const Bytes& bytes) {
    const char* alphabet="0123456789abcdef";std::string out;out.reserve(bytes.size()*2);
    for(BYTE b:bytes){out+=alphabet[b>>4];out+=alphabet[b&15];}return out;
}
static Bytes unhex(const std::wstring& input) {
    if(input.size()%2||input.size()>1060)throw std::runtime_error("Invalid bounded format hex");
    Bytes out;for(size_t i=0;i<input.size();i+=2) {
        auto digit=[](wchar_t c)->unsigned {if(c>=L'0'&&c<=L'9')return c-L'0';if(c>=L'a'&&c<=L'f')return c-L'a'+10;
            if(c>=L'A'&&c<=L'F')return c-L'A'+10;throw std::runtime_error("Invalid format hex");};
        out.push_back((BYTE)((digit(input[i])<<4)|digit(input[i+1])));
    }return out;
}
static std::string sha(const Bytes& bytes) {
    BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;Bytes result(32),workspace;
    auto check=[](NTSTATUS status){if(status<0)throw std::runtime_error("BCrypt SHA256 failed");};
    try {
        check(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0));
        DWORD size=0,count=0;check(BCryptGetProperty(algorithm,BCRYPT_OBJECT_LENGTH,(PUCHAR)&size,sizeof(size),&count,0));
        workspace.resize(size);check(BCryptCreateHash(algorithm,&hash,workspace.data(),size,nullptr,0,0));
        check(BCryptHashData(hash,const_cast<BYTE*>(bytes.data()),(ULONG)bytes.size(),0));
        check(BCryptFinishHash(hash,result.data(),(ULONG)result.size(),0));
        BCryptDestroyHash(hash);hash=nullptr;BCryptCloseAlgorithmProvider(algorithm,0);algorithm=nullptr;
    }catch(...){if(hash)BCryptDestroyHash(hash);if(algorithm)BCryptCloseAlgorithmProvider(algorithm,0);throw;}
    return bytehex(result);
}
static std::wstring env(const wchar_t* name) {
    const wchar_t* value=_wgetenv(name);return value?value:L"";
}
static std::wstring final_path(const fs::path& path) {
    HANDLE handle=CreateFileW(path.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,
                              nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,nullptr);
    if(handle==INVALID_HANDLE_VALUE)throw std::runtime_error("Cannot identify owned evidence path");
    wchar_t buffer[32768];DWORD size=GetFinalPathNameByHandleW(handle,buffer,32768,FILE_NAME_NORMALIZED);
    CloseHandle(handle);if(!size||size>=32768)throw std::runtime_error("Owned evidence path exceeds bound");
    return lower(std::wstring(buffer,size));
}
static void no_links(fs::path path) {
    path=fs::absolute(path);
    for(;;) {
        DWORD attrs=GetFileAttributesW(path.c_str());
        if(attrs!=INVALID_FILE_ATTRIBUTES&&(attrs&FILE_ATTRIBUTE_REPARSE_POINT))
            throw std::runtime_error("Linked evidence ancestors forbidden");
        auto parent=path.parent_path();if(parent==path||parent.empty())break;path=parent;
    }
}
static void owned_file_parent(const fs::path& path,bool must_exist) {
    no_links(path);auto temp=final_path(env(L"RUNNER_TEMP"));auto parent=final_path(path.parent_path());
    if(parent!=temp&&(parent.size()<=temp.size()||parent.compare(0,temp.size(),temp)||parent[temp.size()]!=L'\\'))
        throw std::runtime_error("Only current hosted temporary evidence paths allowed");
    if(lower(path.wstring()).find(env(L"GITHUB_RUN_ID"))==std::wstring::npos)
        throw std::runtime_error("Evidence path must bind current run");
    if(must_exist) {if(!fs::is_regular_file(path))throw std::runtime_error("Regular existing reference required");}
    else if(fs::exists(path))throw std::runtime_error("Fresh output directory required");
}
static void guard_environment() {
    if(sizeof(void*)!=8||env(L"GITHUB_ACTIONS")!=L"true"||env(L"RUNNER_ENVIRONMENT")!=L"github-hosted"||
       env(L"GITHUB_REPOSITORY")!=REPO||env(L"RUNNER_ARCH")!=L"X64"||
       !std::regex_match(env(L"GITHUB_RUN_ID"),std::wregex(L"[0-9]+"))||env(L"RUNNER_TEMP").empty())
        throw std::runtime_error("Explicit owned hosted repository x64 CI required");
}
static void guard(const std::wstring& instance) {
    guard_environment();
    if(!std::regex_match(instance,std::wregex(L"ROOT\\\\DORDIAI_VBCABLE_[0-9A-Fa-f]{32}\\\\[0-9A-Fa-f]+")))
        throw std::runtime_error("Exact owned instance identifier required");
    DEVINST node=0;auto text=instance;
    if(CM_Locate_DevNodeW(&node,text.data(),CM_LOCATE_DEVNODE_NORMAL)!=CR_SUCCESS)
        throw std::runtime_error("Parent-owned instance is absent");
    ULONG status=0,problem=0;
    if(CM_Get_DevNode_Status(&status,&problem,node,0)!=CR_SUCCESS||problem||!(status&DN_STARTED))
        throw std::runtime_error("Parent-owned instance is not started");
    wchar_t ids[4096]{};ULONG size=sizeof(ids),type=0;
    if(CM_Get_DevNode_Registry_PropertyW(node,CM_DRP_HARDWAREID,&type,ids,&size,0)!=CR_SUCCESS||type!=REG_MULTI_SZ)
        throw std::runtime_error("Cannot verify owned instance hardware ID");
    bool vendor=false;size_t bound=std::min<size_t>(size/sizeof(wchar_t),4096),offset=0;
    while(offset<bound&&ids[offset]) {size_t end=offset;while(end<bound&&ids[end])end++;
        if(end==bound)throw std::runtime_error("Unterminated hardware ID");
        if(lower(std::wstring(ids+offset,end-offset))==L"vbaudiovacwdm")vendor=true;
        offset=end+1;
    }
    if(!vendor)throw std::runtime_error("Owned instance is not the verified vendor hardware");
}
static bool observed_name(const std::wstring& name) {
    for(const auto& full:{std::wstring(L"Speakers (VB-Audio Virtual Cable)"),std::wstring(L"CABLE Input (VB-Audio Virtual Cable)")})
        if(name==full||name==full.substr(0,31))return true;return false;
}
struct Endpoint {
    ComPtr<IMMDevice> device;std::wstring id,name;
    std::string json()const{return object({{"id",q(utf8(id))},{"name",q(utf8(name))}});}
};
struct Format {
    Bytes raw;WORD bits=0,channels=0,align=0,tag=0,extra=0;DWORD rate=0,average=0;bool floating=false;
    std::string json()const{return object({{"format_tag",std::to_string(tag)},{"channels",std::to_string(channels)},
        {"sample_rate",std::to_string(rate)},{"average_bytes_per_second",std::to_string(average)},
        {"block_align",std::to_string(align)},{"bits_per_sample",std::to_string(bits)},
        {"extra_bytes",std::to_string(extra)},{"native_encoding",q(floating?"float32le":"pcm16le")},
        {"raw_format_hex",q(bytehex(raw))}});}
};
static Format format_of(IAudioClient* client) {
    WAVEFORMATEX* allocated=nullptr;HRESULT hr=client->GetMixFormat(&allocated);
    if(FAILED(hr)||!allocated) {if(allocated)CoTaskMemFree(allocated);throw std::runtime_error("GetMixFormat "+hexhr(hr));}
    Format format;
    try {
        if(allocated->cbSize>512)throw std::runtime_error("Unbounded native format");
        format.raw.assign((BYTE*)allocated,(BYTE*)allocated+sizeof(WAVEFORMATEX)+allocated->cbSize);
        format.bits=allocated->wBitsPerSample;format.channels=allocated->nChannels;format.align=allocated->nBlockAlign;
        format.tag=allocated->wFormatTag;format.extra=allocated->cbSize;format.rate=allocated->nSamplesPerSec;
        format.average=allocated->nAvgBytesPerSec;
        WORD kind=format.tag;
        if(kind==WAVE_FORMAT_EXTENSIBLE) {
            if(format.extra<22)throw std::runtime_error("Truncated extensible native format");
            auto extensible=(WAVEFORMATEXTENSIBLE*)allocated;
            GUID pcm={0x00000001,0x0000,0x0010,{0x80,0x00,0x00,0xaa,0x00,0x38,0x9b,0x71}};
            GUID floating=pcm;floating.Data1=3;
            if(IsEqualGUID(extensible->SubFormat,floating))kind=WAVE_FORMAT_IEEE_FLOAT;
            else if(IsEqualGUID(extensible->SubFormat,pcm))kind=WAVE_FORMAT_PCM;
            else throw std::runtime_error("Unsupported native extensible subtype");
            if(extensible->Samples.wValidBitsPerSample&&extensible->Samples.wValidBitsPerSample!=format.bits)
                throw std::runtime_error("Unsupported native valid bits");
        }
        format.floating=kind==WAVE_FORMAT_IEEE_FLOAT&&format.bits==32;
        if((!format.floating&&!(kind==WAVE_FORMAT_PCM&&format.bits==16))||format.channels!=2||
           format.rate<8000||format.rate>192000||format.align!=2*(format.bits/8)||format.average!=format.rate*format.align)
            throw std::runtime_error("Only unchanged bounded native stereo float32/PCM16 accepted");
    }catch(...){CoTaskMemFree(allocated);throw;}CoTaskMemFree(allocated);return format;
}
static Endpoint select_endpoint(const std::wstring& observed) {
    if(!observed_name(observed))throw std::runtime_error("Exact known observed full/31char vendor render name required");
    ComPtr<IMMDeviceEnumerator> enumerator;
    HRESULT hr=CoCreateInstance(__uuidof(MMDeviceEnumerator),nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&enumerator));
    if(FAILED(hr))throw std::runtime_error("Create enumerator "+hexhr(hr));
    ComPtr<IMMDeviceCollection> collection;hr=enumerator->EnumAudioEndpoints(eRender,DEVICE_STATE_ACTIVE,&collection);
    if(FAILED(hr))throw std::runtime_error("Enumerate render "+hexhr(hr));
    UINT count=0;hr=collection->GetCount(&count);if(FAILED(hr)||count>32)throw std::runtime_error("Invalid endpoint count");
    Endpoint selected;unsigned matches=0;
    for(UINT i=0;i<count;i++) {
        ComPtr<IMMDevice> device;hr=collection->Item(i,&device);if(FAILED(hr))throw std::runtime_error("Endpoint Item");
        ComPtr<IPropertyStore> properties;hr=device->OpenPropertyStore(STGM_READ,&properties);
        if(FAILED(hr))throw std::runtime_error("Read endpoint properties");
        PROPVARIANT name;PropVariantInit(&name);hr=properties->GetValue(PKEY_Device_FriendlyName,&name);
        std::wstring full;if(SUCCEEDED(hr)&&name.vt==VT_LPWSTR&&name.pwszVal)full=name.pwszVal;
        PropVariantClear(&name);
        bool vendor=full.rfind(L"Speakers (VB-Audio Virtual Cable",0)==0||full.rfind(L"CABLE Input (VB-Audio Virtual Cable",0)==0;
        if(vendor&&(full==observed||(observed.size()==31&&full.substr(0,31)==observed))) {
            LPWSTR id=nullptr;hr=device->GetId(&id);if(FAILED(hr)||!id)throw std::runtime_error("Get endpoint ID");
            selected.device=device;selected.name=full;selected.id=id;CoTaskMemFree(id);matches++;
        }
    }
    if(matches!=1)throw std::runtime_error("Owned vendor endpoint name absent or ambiguous");return selected;
}
class Completion final:public Microsoft::WRL::RuntimeClass<
    Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,Microsoft::WRL::FtmBase,IActivateAudioInterfaceCompletionHandler> {
    HANDLE event_=nullptr;std::mutex mutex_;HRESULT get_=E_PENDING,activate_=E_PENDING;
    ComPtr<IUnknown> interface_;
    // Inline activation blob shares the callback object lifetime retained by the
    // asynchronous API, including a caller timeout. Never PropVariantClear it:
    // pBlobData refers to this object, not CoTaskMem-allocated external memory.
    AUDIOCLIENT_ACTIVATION_PARAMS parameters_{};PROPVARIANT activation_{};
public:
    ~Completion(){if(event_)CloseHandle(event_);}
    bool initialize(){
        parameters_.ActivationType=AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
        parameters_.ProcessLoopbackParams.TargetProcessId=GetCurrentProcessId();
        parameters_.ProcessLoopbackParams.ProcessLoopbackMode=PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
        activation_.vt=VT_BLOB;activation_.blob.cbSize=sizeof(parameters_);
        activation_.blob.pBlobData=(BYTE*)&parameters_;
        event_=CreateEventW(nullptr,TRUE,FALSE,nullptr);return event_!=nullptr;
    }
    PROPVARIANT* activation_parameters(){return &activation_;}
    HANDLE event()const{return event_;}
    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation)override {
        HRESULT activation=E_UNEXPECTED;ComPtr<IUnknown> value;
        HRESULT get=operation->GetActivateResult(&activation,&value);
        {std::lock_guard<std::mutex> lock(mutex_);get_=get;activate_=activation;interface_=value;}
        SetEvent(event_);return S_OK;
    }
    HRESULT result(HRESULT& get,HRESULT& activation,ComPtr<IAudioClient>& output) {
        std::lock_guard<std::mutex> lock(mutex_);get=get_;activation=activate_;
        if(FAILED(get_))return get_;if(FAILED(activate_))return activate_;
        return interface_?interface_.As(&output):E_POINTER;
    }
    void clear(){std::lock_guard<std::mutex> lock(mutex_);interface_.Reset();}
};
static Bytes read_file(const fs::path& path,size_t maximum) {
    auto size=fs::file_size(path);if(!size||size>maximum)throw std::runtime_error("Invalid bounded reference size");
    Bytes bytes((size_t)size);std::ifstream input(path,std::ios::binary);input.read((char*)bytes.data(),bytes.size());
    if(!input||input.peek()!=EOF)throw std::runtime_error("Reference changed while reading");return bytes;
}
static void write_bytes(const fs::path& path,const Bytes& bytes) {
    HANDLE file=CreateFileW(path.c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr);
    if(file==INVALID_HANDLE_VALUE)throw std::runtime_error("Fresh evidence file required");
    DWORD written=0;BOOL ok=WriteFile(file,bytes.data(),(DWORD)bytes.size(),&written,nullptr);CloseHandle(file);
    if(!ok||written!=bytes.size())throw std::runtime_error("Incomplete evidence write");
}
static std::string receipt(const char* name,const Bytes& bytes) {
    return object({{"filename",q(name)},{"size_bytes",std::to_string(bytes.size())},{"sha256",q(sha(bytes))}});
}
static uint64_t perf() {LARGE_INTEGER value;QueryPerformanceCounter(&value);return (uint64_t)value.QuadPart;}
static std::string pcm_facts(const Bytes& raw,const Format& format) {
    size_t values=raw.size()/(format.bits/8);double squares[2]{};size_t nonzero=0;
    for(size_t i=0;i<values;i++) {
        double value=0;if(format.floating){float f;memcpy(&f,raw.data()+i*4,4);value=f;}
        else {int16_t v;memcpy(&v,raw.data()+i*2,2);value=v/32768.;}
        if(!std::isfinite(value))throw std::runtime_error("Nonfinite observed native PCM");
        squares[i%2]+=value*value;if(value!=0)nonzero++;
    }
    return object({{"sha256",q(sha(raw))},{"size_bytes",std::to_string(raw.size())},{"nonzero_samples",std::to_string(nonzero)},
        {"channel_rms","["+number(std::sqrt(squares[0]/std::max<size_t>(1,values/2)))+","+
                              number(std::sqrt(squares[1]/std::max<size_t>(1,values/2)))+"]"}});
}
struct Proof {
    std::map<std::string,std::string> fields;std::vector<std::string> hrs,cleanup,packets,readbacks;
    Proof() {
        fields={{"format",q("dordiai-owned-render-loopback-calibration")},{"format_version","1"},{"status",q("running")},
            {"capture_mode",q("process-include-current-pid")},{"target_pid",std::to_string(GetCurrentProcessId())},
            {"current_pid",std::to_string(GetCurrentProcessId())},
            {"child_processes_created","false"},{"requested_exclude_mode","false"},
            {"physical_audio_verified","false"},{"acoustic_latency_verified","false"},{"product_ready","false"},
            {"known_marker_correlated_verified","false"},{"virtual_audio_verified","false"},
            {"microphone_capture_used","false"},{"privacy_settings_changed","false"},{"default_device_changed","false"},
            {"format_changed","false"},{"service_restart_performed","false"},{"reboot_performed","false"},
            {"scope",q("Own current process INCLUDE-tree capture (no children) and exact newly owned native render; own marker only")}};
    }
    void check(HRESULT hr,const std::string& name) {
        if(hrs.size()<128)hrs.push_back(object({{"operation",q(name)},{"hresult",q(hexhr(hr))}}));
        if(FAILED(hr))throw std::runtime_error(name+" "+hexhr(hr));
    }
    std::string json(){fields["native_call_hresult_log"]=list(hrs);fields["cleanup_errors"]=list(cleanup);
        fields["packets"]=list(packets);fields["render_buffer_readback_proofs"]=list(readbacks);return object(fields);}
};
struct RunResult {Proof proof;Bytes reference,captured;};
static RunResult calibrate(Endpoint& endpoint,const Format& format,const Bytes& reference) {
    RunResult result;result.reference=reference;auto& proof=result.proof;
    proof.fields["selected_endpoint"]=endpoint.json();proof.fields["native_format"]=format.json();
    proof.fields["reference_frames"]=std::to_string(reference.size()/format.align);
    ComPtr<IAudioClient> capture_client,render_client;
    ComPtr<IAudioCaptureClient> capture;ComPtr<IAudioRenderClient> render;
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    auto completion=Microsoft::WRL::Make<Completion>();
    HANDLE packet_event=nullptr;bool capture_started=false,render_started=false,activation_requested=false,callback_complete=false;
    Bytes readback;size_t offset=0;uint64_t padding_count=0,padding_min=UINT64_MAX,padding_max=0;
    try {
        if(!completion||!completion->initialize())throw std::runtime_error("Cannot allocate bounded completion event");
        HRESULT async_hr=ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,__uuidof(IAudioClient),
                                                    completion->activation_parameters(),completion.Get(),&operation);
        proof.fields["async_activation_hresult"]=q(hexhr(async_hr));proof.check(async_hr,"Activate own-process INCLUDE loopback");
        activation_requested=true;
        DWORD wait=WaitForSingleObject(completion->event(),5000);
        proof.fields["activation_wait_result"]=std::to_string(wait);
        if(wait!=WAIT_OBJECT_0)throw std::runtime_error("Own-process activation callback timeout or wait failure");
        callback_complete=true;HRESULT get=E_PENDING,activation=E_PENDING;
        HRESULT qi=completion->result(get,activation,capture_client);
        proof.fields["get_activate_result_hresult"]=q(hexhr(get));proof.fields["activation_hresult"]=q(hexhr(activation));
        proof.check(qi,"Get own-process activated IAudioClient");
        proof.check(endpoint.device->Activate(__uuidof(IAudioClient),CLSCTX_INPROC_SERVER,nullptr,
                                            (void**)render_client.GetAddressOf()),"Activate exact native render");
        auto current=format_of(render_client.Get());if(current.raw!=format.raw)throw std::runtime_error("Native render format changed");
        // Documented Microsoft ApplicationLoopback sample flags. Stream-local
        // conversion permission changes no endpoint or system format setting.
        DWORD flags=AUDCLNT_STREAMFLAGS_LOOPBACK|AUDCLNT_STREAMFLAGS_EVENTCALLBACK|AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
        proof.fields["process_capture_stream_flags"]=std::to_string(flags);
        proof.check(capture_client->Initialize(AUDCLNT_SHAREMODE_SHARED,flags,0,0,
                    (WAVEFORMATEX*)format.raw.data(),nullptr),"Initialize own-process capture native-format contract");
        proof.check(render_client->Initialize(AUDCLNT_SHAREMODE_SHARED,0,0,0,
                    (WAVEFORMATEX*)format.raw.data(),nullptr),"Initialize exact shared native render");
        packet_event=CreateEventW(nullptr,FALSE,FALSE,nullptr);if(!packet_event)throw std::runtime_error("Create capture event");
        proof.check(capture_client->SetEventHandle(packet_event),"Set own-process capture event");
        proof.check(capture_client->GetService(IID_PPV_ARGS(&capture)),"Get own-process IAudioCaptureClient");
        proof.check(render_client->GetService(IID_PPV_ARGS(&render)),"Get exact IAudioRenderClient");
        UINT32 capacity=0;proof.check(render_client->GetBufferSize(&capacity),"Get render capacity");
        if(!capacity||capacity>format.rate*2)throw std::runtime_error("Invalid native buffer capacity");
        proof.fields["render_buffer_frames"]=std::to_string(capacity);
        auto feed=[&](UINT32 frames) {
            BYTE* pointer=nullptr;proof.check(render->GetBuffer(frames,&pointer),"Render GetBuffer");
            bool filled=false;
            try {
                if(!pointer)throw std::runtime_error("Missing native render pointer");
                size_t size=(size_t)frames*format.align,amount=std::min(size,reference.size()-offset);
                memset(pointer,0,size);if(amount)memcpy(pointer,reference.data()+offset,amount);
                Bytes observed(pointer,pointer+size),expected(size);if(amount)memcpy(expected.data(),reference.data()+offset,amount);
                if(observed!=expected)throw std::runtime_error("Actual native render pointer copy mismatch");
                readback.insert(readback.end(),observed.begin(),observed.begin()+amount);
                if(proof.readbacks.size()<128)proof.readbacks.push_back(object({{"frames",std::to_string(frames)},
                    {"marker_byte_offset",std::to_string(offset)},{"marker_bytes",std::to_string(amount)},
                    {"bytes_exact_before_release","true"},{"native_buffer_sha256",q(sha(observed))}}));
                offset+=amount;filled=true;
            }catch(...){HRESULT released=render->ReleaseBuffer(frames,AUDCLNT_BUFFERFLAGS_SILENT);
                if(FAILED(released))proof.cleanup.push_back(q("Render exception ReleaseBuffer "+hexhr(released)));throw;}
            proof.check(render->ReleaseBuffer(frames,filled?0:AUDCLNT_BUFFERFLAGS_SILENT),"Render ReleaseBuffer");
        };
        feed(capacity);
        proof.check(capture_client->Start(),"Start own-process capture");capture_started=true;
        proof.check(render_client->Start(),"Start own marker render");render_started=true;
        auto start=std::chrono::steady_clock::now();size_t maximum=(size_t)format.rate*3;
        std::vector<std::string> padding_trace;
        while(std::chrono::steady_clock::now()-start<std::chrono::seconds(3)&&result.captured.size()/format.align<maximum) {
            UINT32 packet=0;proof.check(capture->GetNextPacketSize(&packet),"Capture next packet");
            unsigned drains=0;
            while(packet&&result.captured.size()/format.align<maximum) {
                if(++drains>1024)throw std::runtime_error("Unbounded capture drain");
                BYTE* data=nullptr;UINT32 frames=0;DWORD packet_flags=0;UINT64 position=0,qpc=0;
                HRESULT hr=capture->GetBuffer(&data,&frames,&packet_flags,&position,&qpc);
                if(hr==AUDCLNT_S_BUFFER_EMPTY)break;
                proof.check(hr,"Capture GetBuffer");
                bool acquired=true;
                try {
                    if(hr!=S_OK||!frames||frames>384000)throw std::runtime_error("Invalid native capture packet");
                    size_t keep=std::min<size_t>(frames,maximum-result.captured.size()/format.align);
                    size_t before=result.captured.size(),bytes=keep*format.align;result.captured.resize(before+bytes);
                    if(packet_flags&AUDCLNT_BUFFERFLAGS_SILENT)memset(result.captured.data()+before,0,bytes);
                    else {if(!data)throw std::runtime_error("Missing capture pointer");memcpy(result.captured.data()+before,data,bytes);}
                    if(proof.packets.size()>=4096)throw std::runtime_error("Capture packet metadata limit");
                    proof.packets.push_back(object({{"frames",std::to_string(frames)},{"retained_frames",std::to_string(keep)},
                        {"flags",std::to_string(packet_flags)},{"device_position_frames",std::to_string(position)},
                        {"qpc_position_100ns",std::to_string(qpc)},{"observed_qpc_ticks",std::to_string(perf())}}));
                    hr=capture->ReleaseBuffer(frames);acquired=false;proof.check(hr,"Capture ReleaseBuffer");
                }catch(...){if(acquired){hr=capture->ReleaseBuffer(frames);if(FAILED(hr))proof.cleanup.push_back(q("Capture exception ReleaseBuffer "+hexhr(hr)));}throw;}
                proof.check(capture->GetNextPacketSize(&packet),"Capture next packet");
            }
            UINT32 padding=0;proof.check(render_client->GetCurrentPadding(&padding),"Render current padding");
            if(padding>capacity)throw std::runtime_error("Invalid render padding");
            padding_count++;padding_min=std::min<uint64_t>(padding_min,padding);padding_max=std::max<uint64_t>(padding_max,padding);
            if(padding_trace.size()<128)padding_trace.push_back(object({{"padding_frames",std::to_string(padding)},
                {"capacity_frames",std::to_string(capacity)},{"observed_qpc_ticks",std::to_string(perf())}}));
            if(capacity>padding)feed(capacity-padding);
            DWORD waited=WaitForSingleObject(packet_event,2);if(waited!=WAIT_OBJECT_0&&waited!=WAIT_TIMEOUT)
                throw std::runtime_error("Capture event wait failure");
        }
        proof.fields["render_padding_observations"]=object({{"count",std::to_string(padding_count)},
            {"minimum_frames",std::to_string(padding_count?padding_min:0)},{"maximum_frames",std::to_string(padding_max)},
            {"first128",list(padding_trace)}});
        proof.fields["captured_frames"]=std::to_string(result.captured.size()/format.align);
        proof.fields["reference_frames_submitted"]=std::to_string(offset/format.align);
        proof.fields["reference_all_submitted"]=offset==reference.size()?"true":"false";
        proof.fields["actual_render_marker_readback"]=pcm_facts(readback,format);
        proof.fields["actual_captured_pcm_facts"]=pcm_facts(result.captured,format);
        if(result.captured.empty()||offset!=reference.size()||readback!=reference)
            throw std::runtime_error("Incomplete bounded capture or actual marker submission");
        proof.fields["capture_wall_seconds"]=number(std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count());
        proof.fields["capture_duration_limit_seconds"]="3";proof.fields["own_marker_duration_seconds"]="1";
        proof.fields["status"]=q("technical-loopback-capture-complete");
    }catch(const std::exception& error){proof.fields["status"]=q("failed");proof.fields["reason"]=q(error.what());}
    if(render_started) {HRESULT hr=render_client->Stop();if(FAILED(hr))proof.cleanup.push_back(q("Render Stop "+hexhr(hr)));}
    if(capture_started) {HRESULT hr=capture_client->Stop();if(FAILED(hr))proof.cleanup.push_back(q("Capture Stop "+hexhr(hr)));}
    capture.Reset();render.Reset();capture_client.Reset();render_client.Reset();
    if(completion&&callback_complete)completion->clear();operation.Reset();completion.Reset();
    if(packet_event)CloseHandle(packet_event);
    proof.fields["async_callback_completed"]=callback_complete?"true":"false";
    proof.fields["async_activation"]=object({{"callback_completed",callback_complete?"true":"false"},
        {"target_pid",std::to_string(GetCurrentProcessId())},{"mode",q("INCLUDE_TARGET_PROCESS_TREE")},
        {"api_hresult",proof.fields.count("async_activation_hresult")?proof.fields["async_activation_hresult"]:"null"},
        {"get_result_hresult",proof.fields.count("get_activate_result_hresult")?proof.fields["get_activate_result_hresult"]:"null"},
        {"activation_hresult",proof.fields.count("activation_hresult")?proof.fields["activation_hresult"]:"null"}});
    proof.fields["all_own_com_interfaces_released"]=(!activation_requested||callback_complete)&&proof.cleanup.empty()?"true":"false";
    if(!proof.cleanup.empty())proof.fields["status"]=q("failed");
    return result;
}
int wmain(int argc,wchar_t** argv) {
    std::map<std::wstring,std::wstring> args;bool describe=false,calibrate_mode=false;bool initialized=false;
    try {
        if(argc==2&&std::wstring(argv[1])==L"--self-test") {
            guard_environment();
            static_assert(sizeof(WAVEFORMATEX)==18,"Native WAVEFORMATEX must remain packed18");
            static_assert(sizeof(GUID)==16,"Native GUID width");
            AUDIOCLIENT_ACTIVATION_PARAMS parameters{};
            parameters.ActivationType=AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
            parameters.ProcessLoopbackParams.TargetProcessId=GetCurrentProcessId();
            parameters.ProcessLoopbackParams.ProcessLoopbackMode=PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
            if(parameters.ProcessLoopbackParams.TargetProcessId!=GetCurrentProcessId()||
               parameters.ProcessLoopbackParams.ProcessLoopbackMode!=PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE||
               !observed_name(L"Speakers (VB-Audio Virtual Cabl")||observed_name(L"Other speakers")||
               sha(Bytes{97,98,99})!="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"||
               unhex(L"0001aF")!=Bytes({0,1,175}))throw std::runtime_error("Native primitive self-test failed");
            bool bad_hex_rejected=false;try{unhex(L"gg");}catch(...){bad_hex_rejected=true;}
            if(!bad_hex_rejected)throw std::runtime_error("Invalid hex accepted");
            std::cout<<object({{"status",q("native-primitives-self-test-passed")},{"device_api_called","false"},
                {"waveformatex_bytes",std::to_string(sizeof(WAVEFORMATEX))},{"target_pid",std::to_string(GetCurrentProcessId())},
                {"child_processes_created","false"},{"audio_verified","false"}})<<std::endl;return 0;
        }
        for(int i=1;i<argc;i++) {
            std::wstring key=argv[i];
            if(key==L"--describe-native-format"){if(describe)throw std::runtime_error("Duplicate mode");describe=true;continue;}
            if(key==L"--calibrate"){if(calibrate_mode)throw std::runtime_error("Duplicate mode");calibrate_mode=true;continue;}
            if(key!=L"--render-name"&&key!=L"--owned-instance-id"&&key!=L"--output"&&key!=L"--reference"&&key!=L"--expected-format-hex")
                throw std::runtime_error("Unknown argument; no arbitrary target PID accepted");
            if(i+1>=argc||args.count(key))throw std::runtime_error("Missing or duplicate argument");args[key]=argv[++i];
        }
        if(describe==calibrate_mode||!args.count(L"--render-name")||!args.count(L"--owned-instance-id"))
            throw std::runtime_error("Exact mode, owned instance and observed render name required");
        guard(args[L"--owned-instance-id"]);
        HRESULT hr=CoInitializeEx(nullptr,COINIT_MULTITHREADED);if(FAILED(hr))throw std::runtime_error("MTA COM "+hexhr(hr));initialized=true;
        {
            Endpoint endpoint=select_endpoint(args[L"--render-name"]);
            ComPtr<IAudioClient> client;hr=endpoint.device->Activate(__uuidof(IAudioClient),CLSCTX_INPROC_SERVER,nullptr,(void**)client.GetAddressOf());
            if(FAILED(hr))throw std::runtime_error("Activate native format "+hexhr(hr));
            Format format=format_of(client.Get());client.Reset();
            if(describe) {
                if(args.size()!=2)throw std::runtime_error("Describe accepts no output/reference arguments");
                std::cout<<object({{"native_format",format.json()},{"selected_endpoint",endpoint.json()},
                    {"capture_mode",q("process-include-current-pid")},{"target_pid",std::to_string(GetCurrentProcessId())}})<<std::endl;
            }else {
                if(args.size()!=5)throw std::runtime_error("Calibrate requires output, reference and exact native format hex");
                fs::path output=fs::absolute(args[L"--output"]),input=fs::absolute(args[L"--reference"]);
                owned_file_parent(output,false);owned_file_parent(input,true);
                Bytes reference=read_file(input,(size_t)format.rate*format.align);
                if(reference.size()!=(size_t)format.rate*format.align)throw std::runtime_error("Exact one-second own marker required");
                if(format.raw!=unhex(args[L"--expected-format-hex"]))throw std::runtime_error("Native format differs from described contract");
                auto initial_hash=sha(reference);if(pcm_facts(reference,format).find("\"nonzero_samples\":0")!=std::string::npos)
                    throw std::runtime_error("Own marker cannot be silent");
                if(!fs::create_directory(output))throw std::runtime_error("Output must be fresh");
                auto result=calibrate(endpoint,format,reference);
                endpoint.device.Reset();CoUninitialize();initialized=false;
                guard(args[L"--owned-instance-id"]);
                if(sha(read_file(input,reference.size()))!=initial_hash)throw std::runtime_error("Own reference input changed");
                result.proof.fields["owned_instance_id"]=q(utf8(args[L"--owned-instance-id"]));
                write_bytes(output/L"reference.pcm",result.reference);
                result.proof.fields["reference_pcm"]=receipt("reference.pcm",result.reference);
                if(!result.captured.empty()){write_bytes(output/L"captured.pcm",result.captured);
                    result.proof.fields["captured_pcm"]=receipt("captured.pcm",result.captured);}
                auto json=result.proof.json();write_bytes(output/L"capture.json",Bytes(json.begin(),json.end()));
                std::map<std::string,std::string> brief;
                for(const auto& key:{"status","reason","capture_mode","target_pid","current_pid","async_callback_completed",
                                     "captured_frames","reference_frames_submitted","reference_all_submitted",
                                     "all_own_com_interfaces_released","physical_audio_verified"})
                    if(result.proof.fields.count(key))brief[key]=result.proof.fields[key];
                std::cout<<object(brief)<<std::endl;
                bool ok=result.proof.fields["status"]==q("technical-loopback-capture-complete")&&
                        result.proof.fields["all_own_com_interfaces_released"]=="true";
                return ok?0:1;
            }
        }
        CoUninitialize();initialized=false;return 0;
    }catch(const std::exception& error) {
        if(initialized)CoUninitialize();
        std::cerr<<error.what()<<std::endl;return 1;
    }
}
