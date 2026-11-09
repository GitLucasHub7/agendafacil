# Configurações por ambiente

Copie a configuração pública do Firebase Console para `<alias>.firebase-config.js`, no mesmo formato de `public/firebase-config.js`. Esses arquivos locais estão ignorados pelo Git. Nunca inclua tokens do Mercado Pago. Antes de usar um ambiente real, ajuste o alias na sua cópia de `.firebaserc` e rode `node scripts/use-env.js <alias>`.
