(async function () {
  const $ = selector => document.querySelector(selector);
  const siteId = new URLSearchParams(location.search).get('site');
  const message = $('#agenda-message');
  const services = $('#services-editor');
  const date = $('#agenda-date');
  let loadedSettings = false;
  let sequence = 0;
  const money = cents => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  function updateState(enabled) { const badge = $('#agenda-state'); badge.dataset.open = String(enabled); badge.textContent = enabled ? 'Agenda aberta' : 'Agenda pausada'; }
  function node(tag, text) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; }
  function showError(err) { message.textContent = err.code === 'functions/internal' ? 'Não foi possível concluir. Tente novamente.' : err.message || 'Não foi possível concluir.'; }
  async function call(action, data = {}) { return (await AF.functions.httpsCallable('manageBookings')({ siteId, action, ...data })).data; }
  function serviceRow(service = { name: '', duration: 30, priceCents: 0 }) {
    const row = node('div'); row.className = 'service-row';
    for (const [field, label, type, value] of [['name', 'Nome', 'text', service.name], ['duration', 'Minutos', 'number', service.duration], ['price', 'Preço (R$)', 'number', (service.priceCents / 100).toFixed(2)]]) {
      const wrapper = node('label', label); const input = node('input'); input.type = type; input.dataset.field = field; input.value = value; input.required = true;
      if (field === 'name') { input.minLength = 2; input.maxLength = 60; }
      else { input.min = field === 'duration' ? '15' : '0'; input.max = field === 'duration' ? '240' : '10000'; input.step = field === 'duration' ? '15' : '0.01'; }
      wrapper.append(input); row.append(wrapper);
    }
    const remove = node('button', 'Remover'); remove.type = 'button'; remove.className = 'secondary'; remove.addEventListener('click', () => row.remove()); row.append(remove); services.append(row);
  }
  for (const [i, label] of ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].entries()) {
    const wrapper = node('label'); const input = node('input'); input.type = 'checkbox'; input.value = i; wrapper.append(input, document.createTextNode(label)); $('#weekday-options').append(wrapper);
  }
  async function load() {
    const current = ++sequence; message.textContent = 'Carregando agenda…';
    try {
      const data = await call('list', { date: date.value });
      if (current !== sequence) return;
      $('#business-name').textContent = data.siteName;
      updateState(data.settings.enabled);
      $('#business-hours').textContent = `Horário de atendimento: ${data.start}–${data.end}. Para mudar, edite o site. Há antecedência mínima de uma hora e reservas até 60 dias à frente.`;
      if (!loadedSettings) {
        $('#booking-enabled').checked = data.settings.enabled;
        $('#weekday-options').querySelectorAll('input').forEach(input => { input.checked = data.settings.days.includes(Number(input.value)); });
        $('#blocked-dates').value = data.settings.blockedDates.join(', ');
        services.replaceChildren(); data.settings.services.forEach(serviceRow); loadedSettings = true;
      }
      const list = $('#appointments'); list.replaceChildren();
      $('#booking-count').textContent = String(data.bookings.filter(b => b.status === 'confirmed').length);
      if (!data.bookings.length) {
        const empty = node('div'); empty.className = 'empty-reservations';
        const icon = node('span', '▦'); icon.className = 'empty-icon'; icon.setAttribute('aria-hidden', 'true');
        empty.append(icon, node('h3', 'Seu dia está livre por aqui'), node('p', 'Nenhuma reserva nesta data. Quando um cliente agendar, os detalhes aparecem aqui.'));
        list.append(empty);
      }
      for (const booking of data.bookings) {
        const card = node('article'); card.className = 'appointment';
        card.append(node('h3', `${booking.time} · ${booking.service}`), node('p', `${booking.name} · ${booking.phone}`), node('p', `${booking.duration} min · ${money(booking.priceCents)} · ${booking.status === 'confirmed' ? 'Confirmada' : 'Cancelada'}`));
        if (booking.status === 'confirmed') {
          const cancel = node('button', 'Cancelar reserva'); cancel.type = 'button'; cancel.className = 'secondary';
          cancel.addEventListener('click', async () => {
            if (!confirm(`Cancelar a reserva de ${booking.name} às ${booking.time}? Avise o cliente diretamente; não enviamos mensagem automática.`)) return;
            cancel.disabled = true;
            try { await call('cancel', { bookingId: booking.id }); await load(); } catch (err) { showError(err); cancel.disabled = false; }
          });
          card.append(cancel);
        }
        list.append(card);
      }
      message.textContent = '';
    } catch (err) { if (current === sequence) showError(err); }
  }
  if (!siteId || !/^[A-Za-z0-9]{10,40}$/.test(siteId)) { message.textContent = 'Abra a agenda pelo painel de sites.'; return; }
  await AF.requireUser();
  date.value = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  date.addEventListener('change', load); $('#refresh-bookings').addEventListener('click', load);
  $('#add-service').addEventListener('click', () => { if (services.children.length >= 12) { message.textContent = 'Máximo de 12 serviços.'; return; } serviceRow(); });
  $('#settings-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('#save-settings'); button.disabled = true;
    try {
      const items = [...services.children].map(row => ({ name: row.querySelector('[data-field=name]').value, duration: Number(row.querySelector('[data-field=duration]').value), priceCents: Math.round(Number(row.querySelector('[data-field=price]').value) * 100) }));
      await call('saveSettings', { settings: { enabled: $('#booking-enabled').checked, days: [...$('#weekday-options').querySelectorAll('input:checked')].map(input => Number(input.value)), blockedDates: $('#blocked-dates').value.split(/[\s,;]+/).filter(Boolean), services: items } });
      updateState($('#booking-enabled').checked);
      message.textContent = 'Configurações salvas. A agenda ficará disponível no site publicado.';
    } catch (err) { showError(err); } finally { button.disabled = false; }
  });
  await load();
})();
