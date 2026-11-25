(function () {
  window.initBooking = async function (site) {
    const box = document.getElementById('booking-box');
    const message = document.getElementById('booking-message');
    const form = document.getElementById('booking-form');
    const service = document.getElementById('booking-service');
    const date = document.getElementById('booking-date');
    const time = document.getElementById('booking-time');
    const submit = document.getElementById('booking-submit');
    const fields = document.getElementById('booking-fields');
    const slug = window.AgendaFacilRender.parseSlugFromPath(location.pathname);
    const functions = firebase.functions();
    if (['localhost', '127.0.0.1'].includes(location.hostname) && firebase.app().options.projectId.startsWith('demo-')) functions.useEmulator('127.0.0.1', 5001);
    const call = async (name, data) => (await functions.httpsCallable(name)(data)).data;
    const errorText = err => err.code === 'functions/internal' ? 'Não foi possível consultar a agenda. Tente novamente.' : err.message || 'Não foi possível concluir agora.';
    let requestKey = crypto.randomUUID();
    let sequence = 0;
    let catalog = [];
    function clearTimes(label) { time.replaceChildren(new Option(label, '')); submit.disabled = true; }
    async function loadSlots() {
      const current = ++sequence;
      clearTimes('Carregando horários…');
      message.textContent = '';
      try {
        const data = await call('getBookingAvailability', { slug, date: date.value, serviceId: service.value });
        if (current !== sequence) return;
        clearTimes(data.slots?.length ? 'Escolha um horário' : 'Nenhum horário disponível');
        for (const value of data.slots || []) time.add(new Option(value, value));
        if (!data.slots?.length) message.textContent = 'Não há horários livres nesta data. Escolha outro dia.';
      } catch (err) { if (current === sequence) { clearTimes('Indisponível'); message.textContent = errorText(err); } }
    }
    box.hidden = false;
    for (const id of ['hero-cta', 'preview-booking-button']) document.getElementById(id).addEventListener('click', () => { box.scrollIntoView({ behavior: 'smooth' }); service.focus(); });
    document.getElementById('preview-dates').hidden = true;
    // O catálogo público usa exclusivamente os preços e serviços confirmados pelo dono.
    const list = document.getElementById('preview-service-list');
    list.replaceChildren();
    try {
      const data = await call('getBookingAvailability', { slug });
      if (/^55\d{10,11}$/.test(data.contactPhone || '')) {
        const contact = document.getElementById('business-contact-link');
        contact.href = 'tel:+' + data.contactPhone;
        contact.textContent = '+' + data.contactPhone;
        document.getElementById('business-contact').hidden = false;
      }
      if (!data.enabled) { message.textContent = 'O estabelecimento ainda não abriu a agenda online.'; form.hidden = true; return; }
      catalog = data.services;
      for (const item of catalog) {
        const price = (item.priceCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        service.add(new Option(`${item.name} · ${item.duration} min · ${price}`, item.id));
        const row = document.createElement('div'); row.className = 'preview-service-row';
        for (const [tag, text] of [['span', '◷'], ['b', item.name], ['small', price]]) { const el = document.createElement(tag); el.textContent = text; row.append(el); }
        list.append(row);
      }
      date.min = data.today; date.max = data.lastDate; date.value = data.today;
      form.hidden = false;
      await loadSlots();
    } catch (err) { message.textContent = errorText(err); return; }
    date.addEventListener('change', loadSlots);
    service.addEventListener('change', loadSlots);
    time.addEventListener('change', () => { submit.disabled = !time.value; });
    form.addEventListener('change', () => { requestKey = crypto.randomUUID(); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!form.reportValidity() || !time.value) return;
      fields.disabled = true; message.textContent = 'Confirmando sua reserva…';
      try {
        const result = await call('createBooking', { slug, date: date.value, time: time.value, serviceId: service.value, name: document.getElementById('booking-name').value, phone: document.getElementById('booking-phone').value, consent: document.getElementById('booking-consent').checked, requestKey });
        if (result.status !== 'confirmed') { message.textContent = 'Esta reserva foi cancelada. Recarregue a página para reservar novamente.'; return; }
        const chosen = catalog.find(s => s.id === service.value);
        message.textContent = `Reserva confirmada!\n${site.name} — ${chosen.name}\n${result.date.split('-').reverse().join('/')} às ${result.time} (horário de Brasília).\nCódigo: ${result.code}\nGuarde esta confirmação. Para alterar ou cancelar, fale com o estabelecimento. Nenhum pagamento foi realizado por este formulário.`;
        form.hidden = true;
        message.focus();
      } catch (err) { message.textContent = errorText(err); fields.disabled = false; }
    });
  };
})();
