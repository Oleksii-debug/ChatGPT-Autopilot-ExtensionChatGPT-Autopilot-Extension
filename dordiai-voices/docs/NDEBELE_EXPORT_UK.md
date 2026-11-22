# Експорт північної ндебеле для локального виконання

Підготовлено справжній ONNX-носій північної ндебеле (`nd`, ISO `nde`) із `multilingual-tts/VITS-OpenBible-Ndebele`, ревізія `b9177e02bcca72b90dee5f331755275a95af946a`, ліцензія CC BY-SA 4.0. Це не заміна південної ндебеле (`nr`).

Початковий тренувальний checkpoint має 997 756 163 байти. Його отримано за незмінним посиланням і перевірено SHA256. У клієнтський пакет він не входить. Граф для виконання має 114 239 454 байти і працює тим самим компактним Coqui/VITS-адаптером, що й інші готові носії. PyTorch, Coqui TTS, optimizer і навчальний discriminator на комп’ютері користувача для цього носія не потрібні.

## Що перевірено

Checkpoint прочитано `torch.load(weights_only=True, mmap=True, map_location='cpu')`. Небезпечних pickle globals не знайдено. Із 949 тензорів моделі 111 належать навчальному discriminator; його не ініціалізовано. Усі потрібні параметри мережі виконання завантажено строго, без пропущених або випадково ініціалізованих ваг. Допоміжні speaker-encoder losses, VGG та ASR не створювалися й не завантажувалися.

Сторінка початкової моделі називає її багатодикторною. Фактичні ваги не мають speaker embedding, а відповідні прапорці конфігурації вимкнені. Тому експорт чесно представляє один некерований за speaker ID носій, а не три окремо вибрані голоси. Його звук надалі перетворюється спільним проєктором у вибраний дозволений голос dordiai-voices.

Виправлено прив’язку параметрів шуму під час експорту: версія Coqui читає `inference_noise_scale` та `inference_noise_scale_dp`. Самої зміни атрибутів `noise_scale` і `noise_scale_dp` недостатньо. Експортований граф зберігає керування шумом і темпом.

Для п’яти різних довжин тексту, включно з трьома токенами й довгим повторенням слова, порівняно справжній PyTorch і ONNX Runtime 1.27.0. Довжини звуку збігаються; найбільша абсолютна різниця PCM — близько 0,000033. Повторні виклики з нульовим шумом дають однакові масиви, а двократне прискорення скорочує звук. Зафіксовані ID офіційного Coqui tokenizer окремо звіряються з легким клієнтським адаптером.

Збережений зразок цього самого носія прочитано як точний PCM16 і подано сумісному FP32 OpenVoice V2 reference encoder. Отримано справжній ненормалізований масив float32 `(1, 256, 1)`. Вектор не скопійовано з іншої мови чи іншого диктора.

Це перевірка моделі, токенізації, перенесення параметрів і числового виконання. Вона не замінює оцінки вимови носієм мови, перевірки звичайних назв усіх символів або приймання у Windows/NVDA. Відповідні прапорці залишені невиконаними.

## Відтворення

Зафіксовані джерела: `tools/ndebele_checkpoint_sources.json`. Код: `tools/export_ndebele_onnx.py`. Навчальні файли зберігаються окремо від клієнтського пакета.

1. `python dordiai-voices/tools/export_ndebele_onnx.py --download-only`
2. В окремому середовищі з CPU PyTorch: `python dordiai-voices/tools/export_ndebele_onnx.py --inspect-offline`
3. У тому самому середовищі: `python dordiai-voices/tools/export_ndebele_onnx.py --export-offline`
4. У середовищі лише з NumPy, SoundFile та перевіреним ONNX Runtime: `python dordiai-voices/tools/export_ndebele_onnx.py --prepare-runtime --report dordiai-voices/evidence/ndebele_preparation.json`

Склад окремого середовища експорту зафіксовано в `tools/ndebele-export-requirements-linux-py312.txt`. Це Linux/Python 3.12 build-only lock, не список залежностей додатка NVDA. Під час офлайнового виконання задаються `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`; телеметрія ONNX Runtime вимикається до створення сеансу.

Протоколи: `evidence/ndebele_checkpoint_inspection.json`, `evidence/ndebele_export.json`, `evidence/ndebele_preparation.json`. Знімок клієнтського tokenizer: `evidence/ndebele_frontend.json`.
