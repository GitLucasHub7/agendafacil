(async function () {
  const $ = s => document.querySelector(s);
  const say = text => { $('#payment-message').textContent = text; };
  const siteId = new URLSearchParams(location.search).get('site');
  if (!siteId || !/^[A-Za-z0-9_-]{6,128}$/.test(siteId)) { $('#payment-site').textContent = 'Selecione um site em Meus sites.'; return; }
  if (!AF.ready || AF.mode !== 'blaze') { $('#payment-site').textContent = 'Pagamento indisponível neste ambiente.'; return; }
  try {
    const user = await AF.requireUser();
    const snap = await AF.db.collection('sites').doc(siteId).get();
    if (!snap.exists || snap.data().ownerUid !== user.uid) throw new Error('Site não encontrado na sua conta.');
    $('#payment-site').textContent = snap.data().name || 'Seu site';
    $('#payment-options').hidden = false;
    let busy = false;
    const buttons = [$('#pay-recurring'), $('#pay-manual')];
    async function pay(billingMode) {
      if (busy) return;
      busy = true; buttons.forEach(b => { b.disabled = true; }); say('Preparando seu pagamento…');
      try {
        await user.reload(); await user.getIdToken(true);
        if (!user.emailVerified) throw new Error('Confirme seu e-mail antes de pagar. Você pode reenviar a confirmação em Meus sites.');
        const result = (await AF.functions.httpsCallable('createSubscription')({ siteId, billingMode })).data;
        if (result.processing) { say('Estamos confirmando a criação do checkout. Aguarde alguns instantes antes de tentar novamente.'); return; }
        if (!/^https:\/\/([a-z0-9-]+\.)*mercadopago\.com(\.[a-z]{2})?\//i.test(result.initPoint || '')) throw new Error('Não foi possível abrir um endereço de pagamento válido.');
        AF.navigate(result.initPoint);
      } catch (err) { say(err.code === 'functions/internal' ? 'Não foi possível preparar o pagamento agora. Tente novamente.' : err.message || 'Não foi possível preparar o pagamento.'); }
      finally { busy = false; buttons.forEach(b => { b.disabled = false; }); }
    }
    $('#pay-recurring').addEventListener('click', () => pay('recurring'));
    $('#pay-manual').addEventListener('click', () => pay('manual'));
  } catch (err) { $('#payment-site').textContent = 'Não foi possível carregar o site.'; say(err.code ? 'Confira sua conexão e tente novamente.' : err.message); }
})();
