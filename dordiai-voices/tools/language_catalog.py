#!/usr/bin/env python3
"""Reproduce selected-language resource coverage from a real unpacked runtime.

No acoustic engine is loaded. A positive resource inventory is not an audio
acceptance result. Run ``python tools/language_catalog.py --help`` for options.
"""
import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_RUNTIME = ROOT / "source/0.12.2/kx47Runtime"


def runtime_module():
    spec = importlib.util.spec_from_file_location("_dordiai_inventory", SOURCE_RUNTIME / "language_catalog.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_scope_data(selected):
    keys = ("id", "name_uk", "regions", "first_priority_region")
    entries = [{key: entry[key] for key in keys} for entry in selected["languages"]]
    data = {"format": 1, "selected_count": len(entries),
            "language_aliases": runtime_module().ALIASES, "entries": entries}
    (SOURCE_RUNTIME / "language_catalog.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def report(runtime):
    module = runtime_module()
    selected = json.loads((ROOT / "selected_languages.json").read_text(encoding="utf-8"))
    rows = module.coverage(runtime / "models")
    selected_ids = {row["runtime_code"] for row in rows}
    all_rows = module.coverage(runtime / "models", selected_only=False)
    summary = {"selected_catalogue_entries": len(rows),
               "registered_with_resources_present": sum(row["resources_present"] for row in rows),
               "registered_with_missing_resources": sum(row["registered"] and not row["resources_present"] for row in rows),
               "not_registered": sum(not row["registered"] for row in rows),
               "windows_audio_verified": 0,
               "existing_unselected_registry_entries": sum(row["runtime_code"] not in selected_ids for row in all_rows),
               "backend_counts_resources_present": dict(Counter(row["backend"] for row in rows if row["resources_present"]))}
    regional = []
    by_id = {row["id"]: row for row in rows}
    for region in selected["regions"]:
        codes = region["languages_in_user_order"]
        regional.append({"name_uk": region["name_uk"], "priority": region["priority"],
                         "selected_entries_in_region": len(codes),
                         "resources_present": sum(by_id[code]["resources_present"] for code in codes),
                         "missing": sum(not by_id[code]["resources_present"] for code in codes)})
    return {"format": 1, "source_package": "0.12.2", "selected_scope": "selected_languages.json",
            "inventory_type": "registration-and-nonempty-resource-presence-only",
            "summary": summary, "regions": regional, "languages": rows,
            "scope_notes_uk": [
                "135 пунктів є вибраним каталогом, а не 135 доведеними акустичними можливостями.",
                "83 позитивні записи — наявні зареєстровані файли; вимову, запуск Windows/NVDA й затримки цей аудит не перевіряє.",
                "Норвезьку зіставлено з nb; існуючий nn залишається окремим необов’язковим варіантом ресурсу, а не додатковою вибраною мовою.",
                "Коморська і Тамазигхт — групові назви; до підбору моделей потрібно визначити точний стандарт.",
                "Для групових записів на кшталт кечуа, фула чи курдської потрібна перевірка конкретного стандарту: один готовий ресурс не доводить покриття всіх різновидів.",
                "Мандаринську не замінено всіма китайськими мовами; філіппінську та чорногорську не підмінено іншими ресурсами через близькість назв.",
                "Наявні 38 записів поза вибором не збільшують виконання цільового каталогу."]}


def markdown(data):
    summary = data["summary"]
    lines = ["# Покриття вибраного мовного каталогу", "",
             "Це відтворювана перевірка реальних файлів основного пакета 0.12.2. Вона не запускає синтез мовлення.", "",
             f"Вибрано {summary['selected_catalogue_entries']} пунктів. Для {summary['registered_with_resources_present']} є реєстрація та необхідні непорожні файли. "
             f"Для {summary['not_registered']} немає зареєстрованого мовного рушія/ресурсів. "
             f"Ще {summary['registered_with_missing_resources']} зареєстрованих пунктів мають відсутні залежності.", "",
             "Позитивний результат інвентаризації не означає перевірену правильність вимови. "
             "Кількість підтверджених цим звітом акустичних перевірок Windows/NVDA: 0.", "",
             "## Наявні типи ресурсів", ""]
    names = {"holos-neural": "Holos: нейромодель", "pocket-neural": "PocketTTS: нейромоделі",
             "piper-neural+voice-conversion": "Piper: нейромоделі з перетворенням тембру",
             "rhvoice-statistical+voice-conversion": "RHVoice: статистичний синтез з перетворенням тембру",
             "shared-neural+voice-conversion": "Спільна багатомовна нейромодель з перетворенням тембру",
             "espeak+voice-conversion": "eSpeak: синтез за правилами з нейронним перетворенням тембру",
             "hebrew-neural+voice-conversion": "Спеціалізована нейромодель з перетворенням тембру"}
    for backend, count in summary["backend_counts_resources_present"].items():
        lines.append(f"- {names.get(backend, backend)}: {count} пунктів.")
    lines += ["", "eSpeak з перетворенням тембру не позначається як нативна нейромодель вимови. "
              "Воно змінює тембр, але не доводить природної артикуляції чи правильних назв символів.", "",
              "## Географічне покриття", "",
              "Мови, спільні для кількох регіонів, тут повторюються; регіональні підсумки не слід додавати для отримання кількості унікальних мов.", ""]
    for region in data["regions"]:
        lines.append(f"- {region['name_uk']}: вибрано {region['selected_entries_in_region']}; "
                     f"ресурси наявні для {region['resources_present']}; відсутні для {region['missing']}.")
    lines += ["", "## Межі висновку", ""] + ["- " + note for note in data["scope_notes_uk"]]
    lines += ["", "Повний машинний перелік зі статусом кожного вибраного пункту: `evidence/language_coverage.json`.", "",
              "Для відсутніх ресурсів потрібні справжні сумісні моделі/фонетичні правила, точні мовні ідентифікатори, "
              "ліцензійні відомості, пакет і перевірка звучання. Підміна іншою мовою або додавання назви в JSON не усуває прогалини.", "",
              "## Відтворення", "",
              "```text", "python tools/language_catalog.py --runtime packages/0.12.2/kx47Runtime", "```", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, default=ROOT / "packages/0.12.2/kx47Runtime")
    parser.add_argument("--report", type=Path, default=ROOT / "evidence/language_coverage.json")
    parser.add_argument("--markdown", type=Path, default=ROOT / "LANGUAGE_COVERAGE_UK.md")
    parser.add_argument("--sync-scope", action="store_true", help="Regenerate runtime selected-language data from approved scope")
    args = parser.parse_args()
    if not (args.runtime / "models").is_dir():
        parser.error("Runtime models directory does not exist; restore the package before inventory")
    if args.sync_scope:
        write_scope_data(json.loads((ROOT / "selected_languages.json").read_text(encoding="utf-8")))
    data = report(args.runtime)
    for path in (args.report, args.markdown):
        path.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.markdown.write_text(markdown(data), encoding="utf-8")
    print(json.dumps(data["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
