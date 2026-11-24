/**
 * Sincroniza pedidos de compra pendentes e seus eventos de rastreio para a aba "Rastreio".
 *
 * Configure FRETECLICK_API_TOKEN nas Script Properties.
 * O token é enviado no header api-token. O documento fictício padrão é 123.123.
 */
const FC_RASTREIO_API_ROOT_ = 'https://api.freteclick.com.br';
const FC_RASTREIO_ORDERS_PATH_ = '/purchasing/orders';
const FC_RASTREIO_SHEET_NAME_ = 'Rastreio';
const FC_RASTREIO_PAGE_SIZE_ = 20;
const FC_RASTREIO_MAX_PAGES_ = 100;
const FC_RASTREIO_MAX_RUNTIME_MS_ = 4 * 60 * 1000;
const FC_RASTREIO_DEFAULT_REAL_STATUS_ = 'pending';
const FC_RASTREIO_STATUS_PT_BR_ = {
  'quote': 'Cotação',
  'waiting client invoice tax': 'Aguardando nota fiscal',
  'automatic analysis': 'Análise automática',
  'analysis': 'Em análise',
  'waiting payment': 'Aguardando pagamento',
  'waiting retrieve': 'Aguardando coleta',
  'collect scheduled': 'Coleta Agendada',
  'on the way': 'Em viagem',
  'waiting invoice tax': 'Aguardando fatura',
  'delivered': 'Entregue',
  'waiting billing': 'Gerando NF',
  'canceled': 'Cancelado',
  'waiting commission': 'Aguardando comissão',
  'ship to carrier': 'Entregar na transportadora',
  'retrieved': 'Coletado',
  'entered the base': 'Entrou na Base',
  'boarded': 'Embarcou',
  'expired': 'Expirado',
  'pending': 'Aguardando Documentação'
};

function atualizarRastreioFreteClick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Já existe uma sincronização de rastreio em andamento.');
  }

  const startedAt = Date.now();
  try {
    const config = fcRastreioGetConfig_();
    const sheet = fcRastreioGetOrCreateSheet_();
    const companies = fcRastreioFetchCompanies_(config);
    if (!companies.length) {
      Logger.log('A API não retornou empresas para esta chave; a planilha foi mantida.');
      return;
    }

    const orders = [];
    companies.forEach(function (company) {
      fcRastreioAssertTime_(startedAt);
      const companyOrders = fcRastreioFetchOpenOrders_(config, company, startedAt);
      Logger.log(
        'Empresa %s (ID %s): %s pedidos pendentes.',
        company.name,
        company.id,
        companyOrders.length
      );
      companyOrders.forEach(function (order) {
        orders.push({ order: order, company: company });
      });
    });

    if (!orders.length) {
      Logger.log(
        'Nenhuma empresa retornou pedidos pendentes. A aba foi mantida sem ' +
        'alterações; nenhuma chamada track/back foi feita.'
      );
      return;
    }

    const rows = [];
    const statusBackgrounds = [];
    const statusFontColors = [];

    orders.forEach(function (item) {
      fcRastreioAssertTime_(startedAt);
      const result = fcRastreioBuildRow_(item.order, item.company, config, startedAt);
      rows.push(result.values);
      statusBackgrounds.push([result.statusColor]);
      statusFontColors.push([fcRastreioContrastText_(result.statusColor)]);
    });

    const headers = [
      'Pedido',
      'Cliente',
      'Status do pedido',
      'Transportadora',
      'Nota fiscal',
      'Previsão de entrega',
      'Consultado em'
    ];

    // Limpa também cores e notas de linhas que não existem mais no resultado.
    sheet.clear();
    sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).clearNote();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    if (rows.length) {
      sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
      const statusRange = sheet.getRange(2, 3, rows.length, 1);
      statusRange.setBackgrounds(statusBackgrounds);
      statusRange.setFontColors(statusFontColors);
      statusRange.setFontWeight('bold');
    }
    const deliveryColumn = headers.indexOf('Previsão de entrega') + 1;
    const deliveryNote = 'A previsão será atualizada após a coleta.';
    // Mantém a orientação somente no cabeçalho; não deixa notas em linhas vazias.
    sheet.getRange(1, deliveryColumn).setNote(deliveryNote);
    sheet.setFrozenRows(1);
    SpreadsheetApp.flush();
    fcRastreioAutoSizeColumns_(sheet, headers, rows);
    Logger.log('Rastreio atualizado. Pedidos: %s', rows.length);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Instala uma execução automática a cada 6 horas (4 vezes ao dia).
 * Executar esta função uma única vez para criar o gatilho.
 */
function instalarGatilhoRastreioFreteClick() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'atualizarRastreioFreteClick') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('atualizarRastreioFreteClick')
    .timeBased()
    .everyHours(6)
    .create();
}

function fcRastreioGetConfig_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('FRETECLICK_API_TOKEN') ||
    props.getProperty('FRETECLICK_TOKEN');
  const document = String(props.getProperty('FRETECLICK_DOCUMENTO') || '123.123').trim();
  const realStatus = String(
    props.getProperty('FRETECLICK_REAL_STATUS') || FC_RASTREIO_DEFAULT_REAL_STATUS_
  ).trim();

  if (!token) {
    throw new Error('Configure FRETECLICK_API_TOKEN nas Script Properties.');
  }
  if (!document) {
    throw new Error('FRETECLICK_DOCUMENTO não pode ficar vazio.');
  }

  return {
    token: token,
    document: document,
    realStatus: realStatus
  };
}

function fcRastreioFetchCompanies_(config) {
  const data = fcRastreioRequest_(
    FC_RASTREIO_API_ROOT_ + '/people/my-companies',
    config.token,
    'application/json'
  );
  const response = data && data.response;
  if (response && response.success === false) {
    throw new Error(response.error || 'Falha ao consultar empresas do cliente.');
  }

  const rawCompanies = response && Array.isArray(response.data)
    ? response.data
    : [];
  const companiesById = {};

  rawCompanies.forEach(function (item) {
    const id = item && item.id !== undefined && item.id !== null
      ? String(item.id)
      : '';
    if (!id) {
      return;
    }
    companiesById[id] = {
      id: id,
      name: String(item.alias || item.name || ('Empresa ' + id)).trim()
    };
  });

  const companies = Object.keys(companiesById).map(function (id) {
    return companiesById[id];
  });
  Logger.log('Empresas encontradas para a chave: %s', companies.length);
  return companies;
}

function fcRastreioFetchOpenOrders_(config, company, startedAt) {
  const ordersById = {};

  for (let page = 1; page <= FC_RASTREIO_MAX_PAGES_; page += 1) {
    fcRastreioAssertTime_(startedAt);
    const query = [
      'itemsPerPage=' + FC_RASTREIO_PAGE_SIZE_,
      'page=' + page,
      'status.realStatus%5B%5D=' + encodeURIComponent(config.realStatus),
      'myCompany=' + encodeURIComponent(company.id),
      'order%5BalterDate%5D=asc'
    ];
    const url = FC_RASTREIO_API_ROOT_ + FC_RASTREIO_ORDERS_PATH_ + '?' + query.join('&');
    Logger.log('Consultando pedidos (sem token na URL): %s', url);
    const data = fcRastreioRequest_(
      url,
      config.token,
      'application/ld+json'
    );
    const pageOrders = fcRastreioExtractOrders_(data);
    Logger.log(
      'Página %s: pedidos recebidos=%s; hydra:totalItems=%s',
      page,
      pageOrders.length,
      data && data['hydra:totalItems'] !== undefined
        ? data['hydra:totalItems']
        : 'não informado'
    );

    let acceptedOnPage = 0;
    pageOrders.forEach(function (order) {
      const orderId = fcRastreioGetOrderId_(order);
      if (orderId) {
        ordersById[company.id + ':' + orderId] = order;
        acceptedOnPage += 1;
      }
    });
    Logger.log('Página %s: itens com ID reconhecido=%s', page, acceptedOnPage);

    if (pageOrders.length < FC_RASTREIO_PAGE_SIZE_) {
      break;
    }
    if (page === FC_RASTREIO_MAX_PAGES_) {
      throw new Error('Limite de páginas atingido para pedidos pendentes.');
    }
  }

  return Object.keys(ordersById).map(function (id) {
    return ordersById[id];
  });
}

function fcRastreioBuildRow_(order, company, config, startedAt) {
  const orderId = fcRastreioGetOrderId_(order);
  if (!orderId) {
    throw new Error('Pedido recebido sem id nem @id do Hydra.');
  }
  const url = FC_RASTREIO_API_ROOT_ + '/track/back/' +
    encodeURIComponent(orderId) + '/' + encodeURIComponent(config.document);
  const checkedAt = new Date();
  const quote = order.quote || (Array.isArray(order.quotes) ? order.quotes[0] : null);
  const carrier = quote && quote.carrier ? quote.carrier : {};
  const invoiceNumbers = (order.invoiceTax || [])
    .map(function (item) {
      return item && item.invoiceTax ? item.invoiceTax.invoiceNumber : '';
    })
    .filter(function (value) {
      return value !== '' && value !== null && value !== undefined;
    })
    .join(', ');

  let trackingData = null;
  let errorMessage = '';
  try {
    fcRastreioAssertTime_(startedAt);
    trackingData = fcRastreioRequest_(url, config.token, 'application/json');
    const response = trackingData && trackingData.response;
    if (!response || !response.success) {
      errorMessage = response && response.error
        ? String(response.error)
        : 'Resposta sem response.success=true.';
    }
  } catch (error) {
    errorMessage = String(error && error.message ? error.message : error);
  }

  const payload = trackingData && trackingData.response &&
    trackingData.response.data ? trackingData.response.data : {};
  const trackingOrder = payload.order || {};
  const orderStatus = trackingOrder.status && trackingOrder.status.status
    ? trackingOrder.status.status
    : (order.status && order.status.status ? order.status.status : '');
  const translatedOrderStatus = fcRastreioTranslateOrderStatus_(orderStatus);
  if (errorMessage) {
    Logger.log(
      'Falha no track/back do pedido %s (empresa %s): %s',
      orderId,
      company.id,
      errorMessage
    );
  }

  const statusColor = fcRastreioNormalizeStatusColor_(
    order.status && order.status.color
  );
  return {
    values: [
      orderId,
      order.client && order.client.name ? order.client.name : '',
      translatedOrderStatus,
      carrier.name || carrier.alias || '',
      invoiceNumbers,
      fcRastreioFormatDeliveryRange_(trackingOrder.deliveryDueDate),
      checkedAt
    ],
    statusColor: statusColor
  };
}

function fcRastreioNormalizeStatusColor_(color) {
  const value = String(color || '').trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : '#e0e0e0';
}

function fcRastreioContrastText_(hexColor) {
  const hex = String(hexColor || '#e0e0e0').replace('#', '');
  const red = parseInt(hex.substring(0, 2), 16);
  const green = parseInt(hex.substring(2, 4), 16);
  const blue = parseInt(hex.substring(4, 6), 16);
  const brightness = (red * 299 + green * 587 + blue * 114) / 1000;
  return brightness < 145 ? '#ffffff' : '#222222';
}

function fcRastreioAutoSizeColumns_(sheet, headers, rows) {
  const minWidth = 90;
  const maxWidth = 420;
  const pixelsPerCharacter = 7;
  const padding = 28;

  headers.forEach(function (header, columnIndex) {
    let longestText = String(header || '').length;
    rows.forEach(function (row) {
      const value = row[columnIndex];
      const textLength = value instanceof Date
        ? 16
        : String(value === null || value === undefined ? '' : value).length;
      longestText = Math.max(longestText, textLength);
    });

    const width = Math.min(
      maxWidth,
      Math.max(minWidth, longestText * pixelsPerCharacter + padding)
    );
    sheet.setColumnWidth(columnIndex + 1, width);
  });
}

/**
 * O endpoint fornece a data inicial. A tela de rastreio exibe uma janela de
 * quatro dias corridos: data inicial até data inicial + 3 dias.
 */
function fcRastreioFormatDeliveryRange_(deliveryDueDate) {
  const value = String(deliveryDueDate || '').trim();
  if (!value) {
    return '';
  }

  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) {
    return value;
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const startDate = new Date(year, month - 1, day);
  const endDate = new Date(year, month - 1, day + 3);
  const timezone = Session.getScriptTimeZone();
  const start = Utilities.formatDate(startDate, timezone, 'dd/MM/yyyy');
  const end = Utilities.formatDate(endDate, timezone, 'dd/MM/yyyy');
  return start + ' a ' + end;
}

/**
 * Mantém os rótulos de status usados pelo Cota Fácil (orders/ui/i18n/pt-br).
 * Se surgir um status novo, exibe o texto original até incluirmos a tradução.
 */
function fcRastreioTranslateOrderStatus_(status) {
  const original = String(status || '').trim();
  const key = original.toLowerCase().replace(/\s+/g, ' ');
  return FC_RASTREIO_STATUS_PT_BR_[key] || original;
}

function fcRastreioRequest_(url, token, accept) {
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: {
      'api-token': token,
      'Accept': accept || 'application/json'
    }
  });
  const statusCode = response.getResponseCode();
  const body = response.getContentText();

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error('HTTP ' + statusCode + ' em ' + url + ': ' + body.slice(0, 1000));
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error('A API retornou JSON inválido em ' + url + '.');
  }
}

function fcRastreioExtractOrders_(data) {
  if (Array.isArray(data)) {
    return data;
  }
  if (data && Array.isArray(data['hydra:member'])) {
    return data['hydra:member'];
  }
  if (data && Array.isArray(data.member)) {
    return data.member;
  }
  return [];
}

/**
 * SalesOrder pode expor "id"; PurchasingOrder pode expor o ID só no IRI Hydra.
 */
function fcRastreioGetOrderId_(order) {
  if (!order) {
    return '';
  }
  if (order.id !== undefined && order.id !== null && String(order.id).trim()) {
    return String(order.id).trim();
  }
  if (order.orderId !== undefined && order.orderId !== null && String(order.orderId).trim()) {
    return String(order.orderId).trim();
  }

  const iri = String(order['@id'] || order['@url'] || '');
  const match = iri.match(/\/(\d+)\/?$/);
  return match ? match[1] : '';
}

function fcRastreioGetOrCreateSheet_() {
  const props = PropertiesService.getScriptProperties();
  const spreadsheetId = props.getProperty('FRETECLICK_SPREADSHEET_ID');
  let spreadsheet = spreadsheetId
    ? SpreadsheetApp.openById(spreadsheetId)
    : SpreadsheetApp.getActiveSpreadsheet();

  if (!spreadsheet) {
    spreadsheet = SpreadsheetApp.create('Rastreio de Pedidos Frete Click');
    props.setProperty('FRETECLICK_SPREADSHEET_ID', spreadsheet.getId());
    const firstSheet = spreadsheet.getSheets()[0];
    firstSheet.setName(FC_RASTREIO_SHEET_NAME_);
    Logger.log('Planilha criada: ' + spreadsheet.getUrl());
    return firstSheet;
  }

  return spreadsheet.getSheetByName(FC_RASTREIO_SHEET_NAME_) ||
    spreadsheet.insertSheet(FC_RASTREIO_SHEET_NAME_);
}

function fcRastreioAssertTime_(startedAt) {
  if (Date.now() - startedAt > FC_RASTREIO_MAX_RUNTIME_MS_) {
    throw new Error(
      'A sincronização se aproximou do limite de execução do Apps Script. ' +
      'A aba anterior foi mantida; tente novamente ou reduza os pedidos/status.'
    );
  }
}
