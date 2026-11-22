[
  {
    "job_id": 137297980229,
    "mode": "characters-only",
    "workflow_conclusion": "success",
    "host_status": "partial",
    "product_ready": false,
    "physical_audio_verified": false,
    "typed_keys": 9,
    "scenario": "characters-only",
    "all_key_routes_passed": true,
    "cleanup": {
      "attempted": true,
      "errors": [],
      "keyboard_config_restored": true,
      "keyboard_layout_restored": true,
      "speech_mode_restored": true
    },
    "preference_restoration": null
  },
  {
    "job_id": 137297980381,
    "mode": "normal",
    "workflow_conclusion": "success",
    "host_status": "partial",
    "product_ready": false,
    "physical_audio_verified": false,
    "latency": {
      "alphabet_first_pass": {
        "count": 176,
        "p50_ms": 1.9417,
        "p95_ms": 2.7613,
        "p99_ms": 7.0201,
        "minimum_ms": 1.5593,
        "maximum_ms": 8.7011
      },
      "warm_letters": {
        "count": 100,
        "p50_ms": 1.6361,
        "p95_ms": 2.1321,
        "p99_ms": 2.2402,
        "minimum_ms": 1.5067,
        "maximum_ms": 2.2785
      },
      "cancel_api": {
        "count": 100,
        "p50_ms": 0.0063,
        "p95_ms": 0.0096,
        "p99_ms": 0.0209,
        "minimum_ms": 0.005,
        "maximum_ms": 0.027
      },
      "warm_switch_requests": {
        "count": 100,
        "p50_ms": 1.7,
        "p95_ms": 2.2586,
        "p99_ms": 2.5058,
        "minimum_ms": 1.5598,
        "maximum_ms": 2.9414
      }
    },
    "benchmark_errors": [],
    "benchmark_timeouts": []
  },
  {
    "job_id": 137297980388,
    "mode": "forced-uk",
    "workflow_conclusion": "success",
    "host_status": "partial",
    "product_ready": false,
    "physical_audio_verified": false,
    "typed_keys": 1,
    "scenario": "forced-uk",
    "all_key_routes_passed": true,
    "cleanup": {
      "attempted": true,
      "errors": [],
      "keyboard_config_restored": true,
      "keyboard_layout_restored": true,
      "speech_mode_restored": true
    },
    "preference_restoration": {
      "restored": true,
      "configuration_scope": "effective isolated AggregatedSection values; owned process discarded afterward"
    }
  },
  {
    "job_id": 137297980396,
    "mode": "ru-missing",
    "workflow_conclusion": "success",
    "host_status": "partial",
    "product_ready": false,
    "physical_audio_verified": false,
    "genuine_ru_recovery": {
      "synthetic_error_injected": false,
      "active_synth": "espeak",
      "configured_synth_preserved": true,
      "old_driver_closed": true,
      "old_driver_thread_stopped": true,
      "notice_pcm_nonzero_bytes": 450612
    }
  },
  {
    "job_id": 137297980439,
    "mode": "typing",
    "workflow_conclusion": "success",
    "host_status": "partial",
    "product_ready": false,
    "physical_audio_verified": false,
    "typed_keys": 9,
    "scenario": "standard",
    "all_key_routes_passed": true,
    "cleanup": {
      "attempted": true,
      "errors": [],
      "keyboard_config_restored": true,
      "keyboard_layout_restored": true,
      "speech_mode_restored": true
    },
    "preference_restoration": null
  },
  {
    "job_id": 137297980449,
    "mode": "navigation",
    "workflow_conclusion": "success",
    "host_status": "partial",
    "product_ready": false,
    "physical_audio_verified": false,
    "typed_keys": 2,
    "scenario": "navigation",
    "all_key_routes_passed": true,
    "cleanup": {
      "attempted": true,
      "errors": [],
      "keyboard_config_restored": true,
      "keyboard_layout_restored": true,
      "speech_mode_restored": true
    },
    "preference_restoration": null
  },
  {
    "job_id": 137297980471,
    "mode": "descriptor-corruption",
    "workflow_conclusion": "success",
    "host_status": "partial",
    "product_ready": false,
    "physical_audio_verified": false,
    "genuine_descriptor_recovery": {
      "synthetic_exception_injected": false,
      "active_synth": "espeak",
      "configured_synth_preserved": true,
      "old_driver_closed": true,
      "old_driver_thread_stopped": true,
      "native_resource_closed": true,
      "native_mapping_reader_released": true,
      "notice_pcm_nonzero_bytes": 875521
    }
  },
  {
    "job_id": 137297980557,
    "mode": "disabled-ru",
    "workflow_conclusion": "success",
    "host_status": "partial",
    "product_ready": false,
    "physical_audio_verified": false,
    "typed_keys": 1,
    "scenario": "disabled-ru",
    "all_key_routes_passed": true,
    "cleanup": {
      "attempted": true,
      "errors": [],
      "keyboard_config_restored": true,
      "keyboard_layout_restored": true,
      "speech_mode_restored": true
    },
    "preference_restoration": {
      "restored": true,
      "configuration_scope": "effective isolated AggregatedSection values; owned process discarded afterward"
    }
  },
  {
    "job_id": 137297980623,
    "mode": "plain-text",
    "workflow_conclusion": "failure",
    "host_status": "failed",
    "product_ready": false,
    "physical_audio_verified": false,
    "plain_cases": [
      {
        "case": "auto_unmarked_100",
        "functional_completed": true,
        "route_audit_passed": false,
        "mismatches": 0,
        "expected_pieces": 102,
        "observed_pieces": 107
      },
      {
        "case": "forced_uk_unmarked_12",
        "functional_completed": true,
        "route_audit_passed": true,
        "mismatches": 0,
        "expected_pieces": 12,
        "observed_pieces": 12
      },
      {
        "case": "disabled_ru_unmarked_12",
        "functional_completed": true,
        "route_audit_passed": true,
        "mismatches": 0,
        "expected_pieces": 12,
        "observed_pieces": 12
      },
      {
        "case": "native_rich_metadata_6",
        "functional_completed": true,
        "route_audit_passed": true,
        "mismatches": 0,
        "expected_pieces": 6,
        "observed_pieces": 6
      },
      {
        "case": "forced_uk_native_metadata_6",
        "functional_completed": true,
        "route_audit_passed": true,
        "mismatches": 0,
        "expected_pieces": 6,
        "observed_pieces": 6
      },
      {
        "case": "disabled_ru_native_metadata_6",
        "functional_completed": true,
        "route_audit_passed": true,
        "mismatches": 0,
        "expected_pieces": 6,
        "observed_pieces": 6
      },
      {
        "case": "auto_native_known_compound_1",
        "functional_completed": true,
        "route_audit_passed": true,
        "mismatches": 0,
        "expected_pieces": 2,
        "observed_pieces": 2
      }
    ],
    "cleanup": {
      "errors": [],
      "private_config_restored": true
    }
  }
]
