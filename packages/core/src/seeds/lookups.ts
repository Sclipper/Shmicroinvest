/**
 * Lookup seeds applied to every new company database (spec 01a section 9).
 * Where the spec gives only counts (countries, banks, currencies) the lists
 * are rebuilt from public data; ids that the business rules depend on
 * (VAT terms, document types 1-7/13/25-43, currencies 1-2) follow the spec.
 */

export const TRANSACTION_TYPES = [
  { id: 1, description: 'Неопределена' },
  { id: 2, description: 'Покупка' },
  { id: 3, description: 'Продажба' },
] as const;
export const TRANSACTION_TYPE = { NotSet: 1, Purchase: 2, Sale: 3 } as const;

export const VIESES = [
  { id: 1, description: 'Не участва в декларацията' },
  { id: 2, description: 'Вътреобщностни доставки' },
  { id: 3, description: 'Посредник в тристранна операция' },
  { id: 4, description: 'Доставки по чл. 21, ал. 2 и чл. 22-24' },
  { id: 5, description: '1 - Изпращане на стоки под режим складиране' },
  { id: 6, description: '2 - Връщане на стоки под режим складиране' },
  { id: 7, description: '3 - Замяна на получател по чл. 15а, ал. 4' },
] as const;

/** VAT terms: (id, transaction type, description, VAT %, default VIES). TypeIdentifier = id. */
export const VAT_TERMS = [
  { id: 1, transactionTypeId: 1, description: 'Вътрешен оборот', vatValue: 0, defaultViesId: 1 },
  { id: 2, transactionTypeId: 2, description: 'Получени доставки, ВОП с право на пълен ДК', vatValue: 20, defaultViesId: 1 },
  { id: 3, transactionTypeId: 2, description: 'Доставки по чл. 82 и без право на ДК', vatValue: 0, defaultViesId: 1 },
  { id: 4, transactionTypeId: 2, description: 'Получени доставки, ВОП с право на частичен ДК', vatValue: 20, defaultViesId: 1 },
  { id: 5, transactionTypeId: 2, description: 'Годишна корекция по чл. 73, ал. 8 и чл. 147, ал. 3', vatValue: 0, defaultViesId: 1 },
  { id: 6, transactionTypeId: 2, description: 'Придобиване при тристранни операции', vatValue: 20, defaultViesId: 1 },
  { id: 7, transactionTypeId: 3, description: 'Облагаеми доставки със ставка 20%', vatValue: 20, defaultViesId: 1 },
  { id: 8, transactionTypeId: 3, description: 'Вътреобщностни придобивания (ВОП)', vatValue: 20, defaultViesId: 1 },
  { id: 9, transactionTypeId: 3, description: 'Доставки по чл. 82, ал. 2-6', vatValue: 0, defaultViesId: 1 },
  { id: 10, transactionTypeId: 3, description: 'Начислен данък за лични нужди', vatValue: 20, defaultViesId: 1 },
  { id: 11, transactionTypeId: 3, description: 'Облагаеми доставки със ставка 9%', vatValue: 9, defaultViesId: 1 },
  { id: 12, transactionTypeId: 3, description: 'Облагаеми доставки със ставка 0%', vatValue: 0, defaultViesId: 1 },
  { id: 13, transactionTypeId: 3, description: 'Вътреобщностни доставки (ВОД)', vatValue: 0, defaultViesId: 2 },
  { id: 14, transactionTypeId: 3, description: 'Доставки по чл. 140, 146 и чл. 173', vatValue: 0, defaultViesId: 1 },
  { id: 15, transactionTypeId: 3, description: 'Услуги по чл. 21, ал. 2 и чл. 22-24', vatValue: 0, defaultViesId: 4 },
  { id: 16, transactionTypeId: 3, description: 'Дистанционни продажби по чл. 69, ал. 2', vatValue: 20, defaultViesId: 1 },
  { id: 17, transactionTypeId: 3, description: 'Освободени доставки', vatValue: 0, defaultViesId: 1 },
  { id: 18, transactionTypeId: 3, description: 'Доставки в тристранни операции', vatValue: 0, defaultViesId: 3 },
] as const;

export const ICA_TYPES = [
  { id: 1, name: 'ВОП' },
  { id: 2, name: 'Услуга от ЕО' },
  { id: 3, name: 'Туристическа услуга/Стоки втора употреба' },
  { id: 4, name: 'Доставка по чл.163а' },
  { id: 5, name: 'Внос по чл.167а' },
  { id: 6, name: 'Режим складиране чл.15а' },
  { id: 7, name: 'Услуга от трета страна' },
  { id: 8, name: 'ВОП - хляб и брашно' },
  { id: 9, name: 'Доставка/Внос на хляб и брашно в страната' },
] as const;

/**
 * Document types. Columns: id (= TypeIdentifier), name, short name, NAP code,
 * sequence channel, visible. Ids 1-7, 13 and 25-43 carry the codes listed in
 * spec 04a 1.6; the internal documents (code 00) are rebuilt from the
 * sequence-channel list of spec 01a 9.2.
 */
export const DOCUMENT_TYPES: {
  id: number; name: string; shortName: string; code: string; channel: number; visible: boolean;
}[] = [
  { id: 1, name: 'Фактура', shortName: 'Ф-ра', code: '01', channel: 2, visible: true },
  { id: 2, name: 'Дебитно известие', shortName: 'ДИ', code: '02', channel: 2, visible: true },
  { id: 3, name: 'Кредитно известие', shortName: 'КИ', code: '03', channel: 2, visible: true },
  { id: 4, name: 'Митническа декларация', shortName: 'МД', code: '07', channel: 0, visible: true },
  { id: 5, name: 'Протокол или друг документ', shortName: 'Прот', code: '09', channel: 0, visible: true },
  { id: 6, name: 'Отчет за извършени продажби', shortName: 'ОП', code: '81', channel: 3, visible: true },
  { id: 7, name: 'Отчет за продажби при специален ред на облагане', shortName: 'ОПС', code: '82', channel: 0, visible: true },
  { id: 8, name: 'Приходен касов ордер', shortName: 'ПКО', code: '00', channel: 4, visible: true },
  { id: 9, name: 'Разходен касов ордер', shortName: 'РКО', code: '00', channel: 5, visible: true },
  { id: 10, name: 'Мемориален ордер', shortName: 'МО', code: '00', channel: 6, visible: true },
  { id: 11, name: 'Банково извлечение', shortName: 'БИ', code: '00', channel: 0, visible: true },
  { id: 12, name: 'Платежно нареждане', shortName: 'ПН', code: '00', channel: 0, visible: true },
  { id: 13, name: 'Протокол по ЗДДС', shortName: 'ПЗДДС', code: '09', channel: 7, visible: true },
  { id: 14, name: 'Фискален бон', shortName: 'ФБ', code: '00', channel: 0, visible: false },
  { id: 15, name: 'Стокова разписка', shortName: 'СР', code: '00', channel: 0, visible: false },
  { id: 16, name: 'Инвентаризационен опис', shortName: 'ИнвО', code: '00', channel: 9, visible: false },
  { id: 17, name: 'Авансов отчет', shortName: 'АО', code: '00', channel: 10, visible: false },
  { id: 18, name: 'Вносна бележка', shortName: 'ВнБ', code: '00', channel: 11, visible: false },
  { id: 19, name: 'Бюджетно платежно нареждане', shortName: 'БПлН', code: '00', channel: 12, visible: false },
  { id: 20, name: 'Банков ордер за валута', shortName: 'БОВал', code: '00', channel: 13, visible: false },
  { id: 21, name: 'Складова разписка', shortName: 'СклР', code: '00', channel: 14, visible: false },
  { id: 22, name: 'Искане за отпускане на материали', shortName: 'ИОтпМ', code: '00', channel: 15, visible: false },
  { id: 23, name: 'Изпълнителен лист', shortName: 'ИЛ', code: '00', channel: 16, visible: false },
  { id: 24, name: 'Заявка за плащане', shortName: 'ЗП', code: '00', channel: 17, visible: false },
  { id: 25, name: 'Фактура (касова отчетност)', shortName: 'Ф-ра(КО)', code: '11', channel: 2, visible: true },
  { id: 26, name: 'Дебитно известие (касова отчетност)', shortName: 'ДИ(КО)', code: '12', channel: 2, visible: true },
  { id: 27, name: 'Кредитно известие (касова отчетност)', shortName: 'КИ(КО)', code: '13', channel: 2, visible: true },
  { id: 28, name: 'Протокол при плащане (касова отчетност)', shortName: 'Прот(КО)', code: '91', channel: 0, visible: true },
  { id: 29, name: 'Протокол за данъчен кредит (касова отчетност)', shortName: 'Прот(КОдк)', code: '92', channel: 0, visible: true },
  { id: 30, name: 'Протокол за изискуем данък - нерегистрирано лице', shortName: 'ПротИДнрл', code: '93', channel: 0, visible: false },
  { id: 31, name: 'Протокол за изискуем данък - регистрирано лице', shortName: 'ПротИДрл', code: '94', channel: 0, visible: false },
  { id: 32, name: 'Справка', shortName: 'Спр', code: '00', channel: 0, visible: false },
  { id: 33, name: 'Ведомост за заплати', shortName: 'ВЗ', code: '00', channel: 0, visible: false },
  { id: 34, name: 'Протокол за безвъзмездно предоставяне на хранителни стоки', shortName: 'ПХрС', code: '95', channel: 0, visible: true },
  { id: 35, name: 'Друг документ', shortName: 'Друг', code: '00', channel: 0, visible: false },
  { id: 36, name: 'Регистър изпращане ЕС - стоки до поискване', shortName: 'РСИЕС', code: '04', channel: 19, visible: false },
  { id: 37, name: 'Регистър получаване ЕС - стоки до поискване', shortName: 'РСПЕС', code: '05', channel: 20, visible: false },
  { id: 38, name: 'Протокол по ЗДДС за гориво с компенсации', shortName: 'ПЗДДСГ', code: '50', channel: 21, visible: true },
  { id: 39, name: 'Отчет за продажби с компенсации за горива', shortName: 'ОИППГ', code: '83', channel: 22, visible: true },
  { id: 40, name: 'Отчет за продажби на хляб', shortName: 'ОИПХ', code: '84', channel: 23, visible: true },
  { id: 41, name: 'Отчет за продажби на брашно', shortName: 'ОИПБ', code: '85', channel: 24, visible: true },
  { id: 42, name: 'Кредитно известие по чл. 126б, ал. 1 ЗДДС', shortName: 'КИ126б', code: '23', channel: 2, visible: false },
  { id: 43, name: 'Протокол по чл. 126б, ал. 2 и 7 ЗДДС', shortName: 'Прот126б', code: '29', channel: 0, visible: false },
];
export const DOCUMENT_TYPE = {
  Invoice: 1, DebitNote: 2, CreditNote: 3, CustomsDeclaration: 4, Protocol: 5,
  CashReceipt: 8, CashPayment: 9, MemorialOrder: 10, BankStatement: 11, VatProtocol: 13,
} as const;

/** Sequence channels seeded per company (ids 1-25: channels 1..20, 999, 21..24). */
export const SEQUENCE_CHANNELS = [...Array.from({ length: 20 }, (_, i) => i + 1), 999, 21, 22, 23, 24];
export const RESET_YEARLY_CHANNELS = new Set([1, 4, 5, 6, 10]);
export const CHANNEL = { Accounting: 1, Invoice: 2, SalesReport: 3, Pko: 4, Rko: 5, Mo: 6, VatProtocol: 7 } as const;

export const CURRENCIES: { id: number; iso: string; name: string; rate: string }[] = [
  { id: 1, iso: 'BGN', name: 'Български лев', rate: '1.000000' },
  { id: 2, iso: 'EUR', name: 'Евро', rate: '1.955830' },
  { id: 3, iso: 'USD', name: 'Щатски долар', rate: '1.000000' },
  { id: 4, iso: 'GBP', name: 'Британска лира', rate: '1.000000' },
  { id: 5, iso: 'CHF', name: 'Швейцарски франк', rate: '1.000000' },
  { id: 6, iso: 'RUB', name: 'Руска рубла', rate: '1.000000' },
  { id: 7, iso: 'JPY', name: 'Японска йена', rate: '1.000000' },
  { id: 8, iso: 'RON', name: 'Румънска лея', rate: '1.000000' },
  { id: 9, iso: 'TRY', name: 'Турска лира', rate: '1.000000' },
  { id: 10, iso: 'HKD', name: 'Хонконгски долар', rate: '1.000000' },
  { id: 11, iso: 'NOK', name: 'Норвежка крона', rate: '1.000000' },
  { id: 12, iso: 'SEK', name: 'Шведска крона', rate: '1.000000' },
  { id: 13, iso: 'DKK', name: 'Датска крона', rate: '1.000000' },
  { id: 14, iso: 'CZK', name: 'Чешка крона', rate: '1.000000' },
  { id: 15, iso: 'HUF', name: 'Унгарски форинт', rate: '1.000000' },
  { id: 16, iso: 'PLN', name: 'Полска злота', rate: '1.000000' },
  { id: 17, iso: 'CAD', name: 'Канадски долар', rate: '1.000000' },
  { id: 18, iso: 'AUD', name: 'Австралийски долар', rate: '1.000000' },
  { id: 19, iso: 'CNY', name: 'Китайски юан', rate: '1.000000' },
  { id: 20, iso: 'ISK', name: 'Исландска крона', rate: '1.000000' },
  { id: 21, iso: 'NZD', name: 'Новозеландски долар', rate: '1.000000' },
  { id: 22, iso: 'SGD', name: 'Сингапурски долар', rate: '1.000000' },
  { id: 23, iso: 'KRW', name: 'Южнокорейски вон', rate: '1.000000' },
  { id: 24, iso: 'ZAR', name: 'Южноафрикански ранд', rate: '1.000000' },
  { id: 25, iso: 'BRL', name: 'Бразилски реал', rate: '1.000000' },
  { id: 26, iso: 'MXN', name: 'Мексиканско песо', rate: '1.000000' },
  { id: 27, iso: 'INR', name: 'Индийска рупия', rate: '1.000000' },
  { id: 28, iso: 'IDR', name: 'Индонезийска рупия', rate: '1.000000' },
  { id: 29, iso: 'ILS', name: 'Израелски шекел', rate: '1.000000' },
  { id: 30, iso: 'MYR', name: 'Малайзийски рингит', rate: '1.000000' },
  { id: 31, iso: 'PHP', name: 'Филипинско песо', rate: '1.000000' },
  { id: 32, iso: 'THB', name: 'Тайландски бат', rate: '1.000000' },
  { id: 33, iso: 'UAH', name: 'Украинска гривна', rate: '1.000000' },
  { id: 34, iso: 'RSD', name: 'Сръбски динар', rate: '1.000000' },
  { id: 35, iso: 'MKD', name: 'Македонски денар', rate: '1.000000' },
  { id: 36, iso: 'AED', name: 'Дирхам на ОАЕ', rate: '1.000000' },
  { id: 37, iso: 'XAU', name: 'Злато (1 трой унция)', rate: '1.000000' },
];

/** ISO 3166 alpha-2 codes are what NAP and VIES use; Delta's Code column is up to 3 chars. */
export const COUNTRIES: { code: string; name: string; nameEn: string }[] = [
  ['BG', 'България', 'Bulgaria'], ['AT', 'Австрия', 'Austria'], ['BE', 'Белгия', 'Belgium'],
  ['HR', 'Хърватия', 'Croatia'], ['CY', 'Кипър', 'Cyprus'], ['CZ', 'Чехия', 'Czechia'],
  ['DK', 'Дания', 'Denmark'], ['EE', 'Естония', 'Estonia'], ['FI', 'Финландия', 'Finland'],
  ['FR', 'Франция', 'France'], ['DE', 'Германия', 'Germany'], ['GR', 'Гърция', 'Greece'],
  ['HU', 'Унгария', 'Hungary'], ['IE', 'Ирландия', 'Ireland'], ['IT', 'Италия', 'Italy'],
  ['LV', 'Латвия', 'Latvia'], ['LT', 'Литва', 'Lithuania'], ['LU', 'Люксембург', 'Luxembourg'],
  ['MT', 'Малта', 'Malta'], ['NL', 'Нидерландия', 'Netherlands'], ['PL', 'Полша', 'Poland'],
  ['PT', 'Португалия', 'Portugal'], ['RO', 'Румъния', 'Romania'], ['SK', 'Словакия', 'Slovakia'],
  ['SI', 'Словения', 'Slovenia'], ['ES', 'Испания', 'Spain'], ['SE', 'Швеция', 'Sweden'],
  ['XI', 'Северна Ирландия', 'Northern Ireland'], ['GB', 'Обединено кралство', 'United Kingdom'],
  ['CH', 'Швейцария', 'Switzerland'], ['NO', 'Норвегия', 'Norway'], ['IS', 'Исландия', 'Iceland'],
  ['LI', 'Лихтенщайн', 'Liechtenstein'], ['TR', 'Турция', 'Turkey'], ['RS', 'Сърбия', 'Serbia'],
  ['MK', 'Северна Македония', 'North Macedonia'], ['AL', 'Албания', 'Albania'], ['ME', 'Черна гора', 'Montenegro'],
  ['BA', 'Босна и Херцеговина', 'Bosnia and Herzegovina'], ['XK', 'Косово', 'Kosovo'], ['MD', 'Молдова', 'Moldova'],
  ['UA', 'Украйна', 'Ukraine'], ['BY', 'Беларус', 'Belarus'], ['RU', 'Русия', 'Russia'],
  ['GE', 'Грузия', 'Georgia'], ['AM', 'Армения', 'Armenia'], ['AZ', 'Азербайджан', 'Azerbaijan'],
  ['US', 'САЩ', 'United States'], ['CA', 'Канада', 'Canada'], ['MX', 'Мексико', 'Mexico'],
  ['BR', 'Бразилия', 'Brazil'], ['AR', 'Аржентина', 'Argentina'], ['CL', 'Чили', 'Chile'],
  ['CN', 'Китай', 'China'], ['JP', 'Япония', 'Japan'], ['KR', 'Южна Корея', 'South Korea'],
  ['IN', 'Индия', 'India'], ['IL', 'Израел', 'Israel'], ['AE', 'Обединени арабски емирства', 'United Arab Emirates'],
  ['SA', 'Саудитска Арабия', 'Saudi Arabia'], ['EG', 'Египет', 'Egypt'], ['ZA', 'Южна Африка', 'South Africa'],
  ['AU', 'Австралия', 'Australia'], ['NZ', 'Нова Зеландия', 'New Zealand'], ['SG', 'Сингапур', 'Singapore'],
  ['HK', 'Хонконг', 'Hong Kong'], ['TH', 'Тайланд', 'Thailand'], ['VN', 'Виетнам', 'Vietnam'],
  ['ID', 'Индонезия', 'Indonesia'], ['MY', 'Малайзия', 'Malaysia'], ['PH', 'Филипини', 'Philippines'],
  ['KZ', 'Казахстан', 'Kazakhstan'], ['UZ', 'Узбекистан', 'Uzbekistan'], ['MA', 'Мароко', 'Morocco'],
  ['TN', 'Тунис', 'Tunisia'], ['NG', 'Нигерия', 'Nigeria'], ['KE', 'Кения', 'Kenya'],
  // Further countries (Delta seeds 171; 01a 9.2).
  ['AD', 'Андора', 'Andorra'], ['MC', 'Монако', 'Monaco'], ['SM', 'Сан Марино', 'San Marino'],
  ['VA', 'Ватикан', 'Vatican City'], ['GI', 'Гибралтар', 'Gibraltar'], ['FO', 'Фарьорски острови', 'Faroe Islands'],
  ['GL', 'Гренландия', 'Greenland'], ['JE', 'Джърси', 'Jersey'], ['GG', 'Гърнзи', 'Guernsey'],
  ['IM', 'Остров Ман', 'Isle of Man'], ['KG', 'Киргизстан', 'Kyrgyzstan'], ['TJ', 'Таджикистан', 'Tajikistan'],
  ['TM', 'Туркменистан', 'Turkmenistan'], ['MN', 'Монголия', 'Mongolia'], ['AF', 'Афганистан', 'Afghanistan'],
  ['PK', 'Пакистан', 'Pakistan'], ['BD', 'Бангладеш', 'Bangladesh'], ['LK', 'Шри Ланка', 'Sri Lanka'],
  ['NP', 'Непал', 'Nepal'], ['MM', 'Мианмар', 'Myanmar'], ['KH', 'Камбоджа', 'Cambodia'],
  ['LA', 'Лаос', 'Laos'], ['TW', 'Тайван', 'Taiwan'], ['MO', 'Макао', 'Macao'],
  ['KP', 'Северна Корея', 'North Korea'], ['IR', 'Иран', 'Iran'], ['IQ', 'Ирак', 'Iraq'],
  ['SY', 'Сирия', 'Syria'], ['LB', 'Ливан', 'Lebanon'], ['JO', 'Йордания', 'Jordan'],
  ['PS', 'Палестина', 'Palestine'], ['KW', 'Кувейт', 'Kuwait'], ['QA', 'Катар', 'Qatar'],
  ['BH', 'Бахрейн', 'Bahrain'], ['OM', 'Оман', 'Oman'], ['YE', 'Йемен', 'Yemen'],
  ['DZ', 'Алжир', 'Algeria'], ['LY', 'Либия', 'Libya'], ['SD', 'Судан', 'Sudan'],
  ['ET', 'Етиопия', 'Ethiopia'], ['TZ', 'Танзания', 'Tanzania'], ['UG', 'Уганда', 'Uganda'],
  ['GH', 'Гана', 'Ghana'], ['CI', 'Кот д\'Ивоар', "Côte d'Ivoire"], ['SN', 'Сенегал', 'Senegal'],
  ['CM', 'Камерун', 'Cameroon'], ['AO', 'Ангола', 'Angola'], ['MZ', 'Мозамбик', 'Mozambique'],
  ['ZW', 'Зимбабве', 'Zimbabwe'], ['ZM', 'Замбия', 'Zambia'], ['NA', 'Намибия', 'Namibia'],
  ['BW', 'Ботсвана', 'Botswana'], ['MG', 'Мадагаскар', 'Madagascar'], ['MU', 'Мавриций', 'Mauritius'],
  ['SC', 'Сейшели', 'Seychelles'], ['CD', 'ДР Конго', 'DR Congo'], ['CG', 'Република Конго', 'Republic of the Congo'],
  ['RW', 'Руанда', 'Rwanda'], ['ML', 'Мали', 'Mali'], ['BF', 'Буркина Фасо', 'Burkina Faso'],
  ['NE', 'Нигер', 'Niger'], ['TD', 'Чад', 'Chad'], ['MR', 'Мавритания', 'Mauritania'],
  ['GA', 'Габон', 'Gabon'], ['BJ', 'Бенин', 'Benin'], ['TG', 'Того', 'Togo'],
  ['GN', 'Гвинея', 'Guinea'], ['SL', 'Сиера Леоне', 'Sierra Leone'], ['LR', 'Либерия', 'Liberia'],
  ['CV', 'Кабо Верде', 'Cabo Verde'], ['SO', 'Сомалия', 'Somalia'], ['DJ', 'Джибути', 'Djibouti'],
  ['ER', 'Еритрея', 'Eritrea'], ['MW', 'Малави', 'Malawi'], ['LS', 'Лесото', 'Lesotho'],
  ['SZ', 'Есватини', 'Eswatini'], ['CO', 'Колумбия', 'Colombia'], ['PE', 'Перу', 'Peru'],
  ['VE', 'Венецуела', 'Venezuela'], ['EC', 'Еквадор', 'Ecuador'], ['BO', 'Боливия', 'Bolivia'],
  ['PY', 'Парагвай', 'Paraguay'], ['UY', 'Уругвай', 'Uruguay'], ['GY', 'Гаяна', 'Guyana'],
  ['SR', 'Суринам', 'Suriname'], ['CU', 'Куба', 'Cuba'], ['DO', 'Доминиканска република', 'Dominican Republic'],
  ['HT', 'Хаити', 'Haiti'], ['JM', 'Ямайка', 'Jamaica'], ['TT', 'Тринидад и Тобаго', 'Trinidad and Tobago'],
  ['BS', 'Бахамски острови', 'Bahamas'], ['BB', 'Барбадос', 'Barbados'], ['PA', 'Панама', 'Panama'],
  ['CR', 'Коста Рика', 'Costa Rica'], ['NI', 'Никарагуа', 'Nicaragua'], ['HN', 'Хондурас', 'Honduras'],
  ['SV', 'Салвадор', 'El Salvador'], ['GT', 'Гватемала', 'Guatemala'], ['BZ', 'Белиз', 'Belize'],
  ['PR', 'Пуерто Рико', 'Puerto Rico'], ['KY', 'Кайманови острови', 'Cayman Islands'], ['VG', 'Британски Вирджински острови', 'British Virgin Islands'],
  ['BM', 'Бермудски острови', 'Bermuda'], ['MV', 'Малдиви', 'Maldives'], ['BN', 'Бруней', 'Brunei'],
  ['FJ', 'Фиджи', 'Fiji'], ['PG', 'Папуа Нова Гвинея', 'Papua New Guinea'], ['MH', 'Маршалови острови', 'Marshall Islands'],
].map(([code, name, nameEn]) => ({ code: code!, name: name!, nameEn: nameEn! }));

export const EU_COUNTRY_CODES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'XI',
]);

/** Bulgarian banks with BIC codes (the BIC is what the IBAN lookup matches on: IBAN chars 5-8). */
export const BANKS: { code: string; name: string }[] = [
  ['BNBGBGSF', 'Българска народна банка'],
  ['UNCRBGSF', 'УниКредит Булбанк АД'],
  ['STSABGSF', 'Банка ДСК АД'],
  ['UBBSBGSF', 'Обединена българска банка АД'],
  ['RZBBBGSF', 'Райфайзенбанк (България) - вече ОББ'],
  ['TTBBBG22', 'Сосиете Женерал Експресбанк - вече ОББ'],
  ['BPBIBGSF', 'Юробанк България АД (Пощенска банка)'],
  ['PIRBBGSF', 'Пиреос Банк България - вече Юробанк'],
  ['FINVBGSF', 'Първа инвестиционна банка АД'],
  ['CECBBGSF', 'Централна кооперативна банка АД'],
  ['NASBBGSF', 'Българска банка за развитие АД'],
  ['PRCBBGSF', 'ПроКредит Банк (България) ЕАД'],
  ['IABGBGSF', 'Интернешънъл Асет Банк АД'],
  ['TBIBBGSF', 'ТИ БИ АЙ Банк ЕАД'],
  ['NBDBBGSF', 'Българска банка за развитие АД'],
  ['TEXIBGSF', 'Тексим Банк АД'],
  ['IORTBGSF', 'Инвестбанк АД'],
  ['DEMIBGSF', 'Търговска банка Д АД'],
  ['CREXBGSF', 'Токуда Банк АД'],
  ['BGUSBGSF', 'Българо-американска кредитна банка АД'],
  ['TCZBBGSF', 'Т.Р. Зираат Банкасъ - клон София'],
  ['ISBKBGSF', 'Ишбанк АГ - клон София'],
  ['CITIBGSF', 'Ситибанк Европа АД - клон България'],
  ['INGBBGSF', 'ING Bank N.V. - клон София'],
  ['BNPABGSX', 'БНП Парибас С.А. - клон София'],
  ['SOMBBGSF', 'Общинска банка АД'],
  ['INTFBGSF', 'myPOS'],
  ['ESPYBGS1', 'Изипей АД'],
  ['ECFEBG22', 'Еконт Файненшъл Сървисис'],
  ['EVIULT2V', 'Paysera LT'],
  // Appended to reach Delta's 46 rows. Reconstructed from public sources (BNB
  // register of BAE/BIC codes and its republications), not from Delta's seed;
  // historical banks are kept so that old IBANs still resolve. Ids are
  // positional: append only.
  ['BUINBGSF', 'Алианц Банк България АД'],
  ['CRBABGSF', 'Алфа Банк - клон България (до 2016 г.)'],
  ['KORPBGSF', 'Корпоративна търговска банка АД (до 2014 г.)'],
  ['CBUNBGSF', 'МКБ Юнионбанк АД (до 2016 г.)'],
  ['BUIBBGSF', 'СИБАНК ЕАД (до 2018 г.)'],
  ['BINVBGSF', 'Креди Агрикол България ЕАД (Емпорики Банк)'],
  ['RIBRBG22', 'Регионална инвестиционна банка - клон България'],
  ['BFTBBGSF', 'Булбанк АД (до 2007 г., вече УниКредит Булбанк)'],
  ['BACXBGSF', 'ХВБ Банк Биохим АД (до 2007 г., вече УниКредит Булбанк)'],
  ['BNBGBGSD', 'Българска народна банка (RINGS)'],
  ['BIGKBGSF', 'Бигбанк АС - клон България'],
  ['VGAGBGSF', 'Варенголд Банк АГ - клон София'],
  ['PATCBGSF', 'Пейнетикс АД'],
  ['TRIVBGS1', 'Транскарт Файненшъл Сървисис АД'],
  ['TRUDBG21', 'Райвъл (ЕУ) ЕАД'],
  ['MYFNBGSF', 'Майфин ЕАД'],
].map(([code, name]) => ({ code: code!, name: name! }));

export const ADDRESS_TYPES = [
  { id: 1, description: 'Регистрация' },
  { id: 2, description: 'За контакт' },
  { id: 3, description: 'За кореспонденция на подаващия VIES' },
] as const;

export const DEPRECIATION_CATEGORIES = [
  { id: 1, description: 'I - Сгради, съоръжения' },
  { id: 2, description: 'II - Машини, оборудване' },
  { id: 3, description: 'III - Транспортни средства' },
  { id: 4, description: 'IV - Компютри, софтуер' },
  { id: 5, description: 'V - Автомобили' },
  { id: 6, description: 'VI - ДМА и ДНМА с ограничен срок' },
  { id: 7, description: 'VII - Други ДА' },
  { id: 8, description: 'Земи и гори' },
] as const;

export const DEPRECIATION_METHODS = [
  { id: 1, description: 'Линеен' },
  { id: 2, description: 'Потребителски' },
  { id: 3, description: 'Прогресивен' },
  { id: 4, description: 'Дегресивен' },
] as const;

export const TERMINATION_TYPES = [
  { id: 1, description: 'Неотписан' },
  { id: 2, description: 'Без операция' },
  { id: 3, description: 'Бракуване/липси' },
  { id: 4, description: 'Продажба' },
  { id: 5, description: 'Изхабяване' },
] as const;

export const PAYMENT_DOCUMENT_TYPES = [
  { id: 0, description: 'NA' },
  { id: 1, description: 'Нареждане разписка' },
  { id: 2, description: 'Вносна бележка' },
  { id: 3, description: 'Платежно нареждане за кредитен превод' },
  { id: 4, description: 'Платежно нареждане за директен дебит' },
  { id: 5, description: 'Платежно нареждане' },
  { id: 6, description: 'Вносна бележка за плащане към бюджета' },
  { id: 7, description: 'Пътен лист' },
  { id: 8, description: 'Нареждане за масово плащане' },
] as const;

export const KEYWORDS = ['фактура', 'ф-ра', 'ф.', 'фак.', 'ф', 'фак', 'invoice', 'inv', 'inv.'];

export const DEFAULT_ROLES = [
  { id: 1, name: 'Потребителски групи', parentId: null, isReadOnly: true },
  { id: 2, name: 'Администратор', parentId: 1, isReadOnly: true },
  { id: 3, name: 'Главен счетоводител', parentId: 1, isReadOnly: false },
  { id: 4, name: 'Счетоводители', parentId: 1, isReadOnly: false },
  { id: 5, name: 'Оперативни счетоводители', parentId: 1, isReadOnly: false },
] as const;
