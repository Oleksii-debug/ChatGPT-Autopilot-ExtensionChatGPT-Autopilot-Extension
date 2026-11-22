# Продовження dordiai-voices

Користувач доручив працювати автономно до погодженої кінцевої цілі, без додаткових запитів. Працювати лише в dordiai-voices та його спеціальних workflow, гілка dordiai-voices/audit-20261122. Корінь координує Git-коміти; субагенти не пересувають гілку. Не змінювати сторонній Autopilot, старий поширений0.12.1 або виключені вісім профілів.

## Незмінна поточна збірка

11: source84ca83e36e729fece88fc56af078a0de826d9db3, run45029834209, artifact14757229220. Архів1 992 938 157байтів/SHA256223e5ea7b29d0f9d16f3ca653711e8ced281c0fc7d5bd2fb891018a73926eceb.1058 тестів загалом:1022 passed,36 skipped.225 реальних упакованих запитів/45 профілів/5 нових мовних умов, незмінні180 банки й1596 private-runtime файлів. Не накладати повторно старий overlay банків на11.

Draft core11: release454496891/coreasset779291724/receipt779295872; усі повні readback SHA перевірено. Draft AfriSix:454498261/шість ZIP і receipt779299684; усі сім readback перевірено. Точні receipts у evidence/. Нічого не публікувати як повністю готове за самою наявністю архіву.

## Нові фактичні результати

NVDA11 run45033534150: усі чотири фактичні звіти partial з нульовою кількістю failedchecks. Normal176glyph+100letter+100switch+100cancel, typing9keys, genuineRuAccentmissing і nativeDescriptorcorruption проходять функціонально. Normal GitHub job failure — тільки allowlistheadlessblockedchecks; не приховувати цього й не робити висновок з одного зеленого/червоного значка. Деталі evidence/source11_nvda_45033534150.json та чотири точні gzip.

Встановлений DMLX18,66MB:6 642 550 слів,97 source/controlcases, actual266plain/270namespacepath; reader і manager через усі обгортки однакові. Manager1000 median1,46–2,52мс/P952,24–3,03мс; суміш96 слів перевищує32blockLRU, тому це не повністю гарячий кеш. Словник звірено повністю з обома вихідними потоками;196509sharedforms неоднозначні. Genuinecorrupt558Bdescriptor→registeredresourceerror→real eSpeak notice→закритий mapping/worker, exactrestore після зупинки процесів.

Реальний plain-file/TextInfo100words + forced/disabled + authoredRichEditmetadata: run45034220666, immutable11, helperd576d2959f6ed0a25548b1e1b16b5c2733f9fa68.17 локальних тестів і композиція plugin пройдено. Фактично45034918498 це ПІДТВЕРДЖЕНО: originalNone→synthUK, усі100 слів/102 частини збережені,71 частина/69 слів помилковоUK. Усі30RU-exclusive occurrences такожUK. Окремі forcedUK і disabledRU plain controls passed. Точний доказ — evidence/source11_plain_text_provenance_failure.md. Для авторських richmetadata ввімкнути справжній detectFormatAfterCursor лише в ізольованому тесті та точно відновити; попередні3 metadata cases були BLOCKED, не passed. Не виправляти тест під помилковий продукт; справжні авторські мітки повинні лишатися пріоритетними. Виробниче виправлення — тільки12.

Справжній WavePlayer пройдено на контрольному10, run45032356299, безRecordingPCMSink, P95preparedglyph3,385мс. Мікрофонна captureInitializeE_ACCESSDENIED, MMEopen1. Не змінювати privacy/defaultdevice/cert/security. Наступний boundedknown-marker render-loopback тільки власного нового signedvendorendpoint без2GBcoredownload. Калібрування не є фізичним чи акустичним прийманням.

MNI repair45033534125:24shapeexpressions corrected,405 learnedpayloads unchanged, fixed original/repairbitexact, dynamiclengths/bothspeakers працюють. Утім fixedfloat/PCM критерії не пройдено, до6LSB, word~0,53–0,71с. backend_accepted=false; не інтегрувати й не послаблювати критерії. Native8cases original/compact bitexact і safeweights-only архів збережено.

## Відкриті цілі

135selected/45profiles; ресурси127=126complete+1partial,8missing з урахуванням старих optionalpacks і нових шести Afri. Не називати це127 прийнятими носіями мовами. Нові SS/VE дають+2; заміни ZU/WO/NSO не дають+3. ZGH залишається partial до справжнього окремого доказу; HiriMotu не підміняти Motu.

Відкриті: усі необхідні звичайні назви символів, швидке непідготовлене змішане читання й друкування на всьому обсязі, реальна вимова/носії, physicaloutput, коректні нові missinglanguagefrontends, голосові стилі лише там, де фактично підтримані. Tonganstrictfrontend досліджується; macronlongvowel і writtenVV — різні ядра, не зливати. Фабрика оригінальних голосів — суміжне дослідження, не обіцяти сотню готових нових голосів.

## Середовище й перевірки

Локальний executor доступний з explicitworkdir та /bin/bash. Перевірений tracked snapshot888members знаходиться у /workspace/scratch/eb1194a9e557/repo-source, source8b1fed1251277b328268979360cfa32aa1df244c; це не Gitcheckout і не останній HEAD. Не перезаписувати його змінами інших власників без координації. Python3.12.14/NumPy наявні; Torch/ONNX не припускати. Реальні Windows/NVDA/моделі запускати через власні GitHubActions.

Artifact connector повертає короткочасний storage downloadURL; тримати його в пам’яті, не друкувати, завантажувати локально з перевіркою розміру/SHA та безпечним розпакуванням. Git-джерело проєкту вже збережене зовні; не дублювати великі моделі чи весь репозиторій у другому сховищі. Машинна істина — WORK_STATE.json/evidence/product_acceptance.json, product_ready=false до виконання всіх вимог.
