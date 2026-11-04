// Text of the document members sign. Stored in the `documents` table on first seed;
// the database copy is what the app serves and what each signature refers to.
export const DOCUMENT_SLUG = 'redco-ministry-2026';

export const DOCUMENT_CONTENT = {
  ka: {
    title: 'წერილები შპს „რედკოს“ და ეკონომიკის სამინისტროს',
    summary: 'ამხანაგობა ამზადებს ორ წერილს დეველოპერთან და განცხადებას ეკონომიკისა და მდგრადი განვითარების სამინისტროში (სივრცითი და ქალაქთმშენებლობითი განვითარების სააგენტო; ტექნიკური და სამშენებლო ზედამხედველობის სააგენტო). საბოლოო ტექსტს თავმჯდომარე გაგზავნამდე აფორმებს.',
    sections: [
      {
        tone: 'danger', tag: 'წერილი №1 · შპს „რედკო“',
        title: 'მისასვლელი გზის ჩაკეტვა, სახანძრო უსაფრთხოება და ხმაური',
        items: [
          { lead: 'საევაკუაციო და მისასვლელი გზა', text: 'კორპუსს თავდაპირველად ორი მისასვლელი გზა ჰქონდა. ერთ-ერთი სრულად არის გადაკეტილი და მასზე კომერციული მიზნით განთავსებულია კერძო სავაჭრო ჯიხურები და სცენა. ნაკვეთს (71.62.58.548) ოფიციალურად რეგისტრირებული მისასვლელი გზა არ აქვს, ხოლო ერთადერთი დარჩენილი მისასვლელი ჩიხურია. ეს ეწინააღმდეგება საქართველოს მთავრობის №41 დადგენილების ქვეთავს 915 (სახანძრო და საავარიო-სამაშველო ტექნიკის მისასვლელი გზის დაგეგმარება).' },
          { lead: 'ხმაური სცენიდან და ჯიხურებიდან', text: 'ჩაკეტილ გზაზე განთავსებული სცენიდან და ჯიხურებიდან მუდმივად ვრცელდება გადაჭარბებული ხმაური, რაც აუარესებს მობინადრეთა და დამსვენებელთა პირობებს და ხელს უშლის კორპუსის ნორმალურ ფუნქციონირებას.' },
        ],
        demands: {
          title: 'მოთხოვნები',
          items: [
            'წერილობითი განმარტება: ვინ გასცა გზის ჩაკეტვის ნებართვა და ვინ იღებს სამართლებრივ პასუხისმგებლობას ხანძრის შემთხვევაში.',
            'გზის დაუყოვნებლივ გათავისუფლება ჯიხურებისა და სცენისგან.',
            'ხმაურის წყაროს აღკვეთა.',
          ],
          after: 'წინააღმდეგ შემთხვევაში ამხანაგობა მიმართავს საგანგებო სიტუაციების მართვის სამსახურსა და მუნიციპალურ ინსპექციას.',
        },
      },
      {
        tone: 'neutral', tag: 'წერილი №2 · შპს „რედკო“',
        title: 'სამშენებლო, საპროექტო და ტექნიკური უსაფრთხოების დარღვევები',
        intro: 'ამხანაგობის პოზიციით, კორპუსი აშენდა სანებართვო პირობებიდან გადახვევით, რომლის დაკანონება მხოლოდ პროექტის კორექტირებით, ფიზიკური გამოსწორების გარეშე, დაუშვებელია.',
        items: [
          { lead: 'აალებადი ფასადი', text: 'შენობა მოპირკეთებულია აგურის ფაქტურის თბოსაიზოლაციო მასალით (XPS), რაც №41 დადგენილებით აკრძალულია ხანძრის სწრაფი გავრცელების რისკის გამო.' },
          { lead: 'სახანძრო სისტემა', text: 'სახანძრო-საინჟინრო მოწყობილობები და ქსელები არ მუშაობს.' },
          { lead: 'ბინების რაოდენობა', text: 'პროექტით გათვალისწინებული 60 კვ.მ აპარტამენტები ორად არის გაყოფილი; ბინების რაოდენობა გაორმაგებულია, რაც ზრდის დატვირთვას საევაკუაციო გზებსა და საინჟინრო ქსელებზე.' },
          { lead: 'ლიფტები', text: 'ლიფტები ჩადის მხოლოდ პარკინგამდე (−1) და არ ჩადის პროექტში დატანილ −2 და −3 კომერციულ სართულებზე.' },
          { lead: 'კანალიზაცია სპრინკლერების ქვეშ', text: 'პარკინგის სართულზე ავტოსაშხეფების ქვეშ კანალიზაციის მილები გადის, რაც №41 დადგენილებით დაუშვებელია.' },
          { lead: 'წყალი, პარკინგი, ფასადი', text: 'წყლის ქსელის დარღვევების გამო წყალმომარაგების კომპანია უარს ამბობს აბონირებაზე და კორპუსი „რედკოს“ წყალზეა დამოკიდებული; უკანა ფასადი პარკინგის დონეზე არ არის მოპირკეთებული; პარკინგის იატაკი დაუსრულებელი და დაუხაზავია; საწვიმარი მილები არ არის დამაგრებული ან საერთოდ არ არის.' },
        ],
      },
      {
        tone: 'info', tag: 'განცხადება · ეკონომიკის სამინისტრო',
        title: 'საერთო ქონების დაბრუნება და ადმინისტრაციულ წარმოებაში ჩართვა',
        items: [
          { lead: 'საერთო ფართები და საქვაბე', text: '№41 დადგენილებით სავალდებულო საერთო ფართები (სველი წერტილები, საკომუნიკაციო არხები, მრიცხველების ოთახები, სკი-დეპოები) და საქვაბე, საიდანაც სხვა კორპუსებიც მარაგდება ცხელი წყლით, რეგისტრირებულია შპს „რედკოს“ სახელზე. ამხანაგობა ითხოვს მათ გადმოცემას ბმა „ალპიკის“ საკუთრებაში.' },
        ],
        demands: {
          title: 'სამინისტროსგან ვითხოვთ',
          items: [
            'ბმა „ალპიკის“ ჩართვას დაინტერესებულ მხარედ ნაკვეთთან (71.62.58.548) დაკავშირებულ ყველა ადმინისტრაციულ წარმოებაში.',
            'კორექტირებული პროექტის შეთანხმებისა და ექსპლუატაციაში მიღების დაუშვებლობას ამხანაგობის თანხმობისა და დარღვევების ფიზიკური აღმოფხვრის გარეშე.',
            'ადგილზე სახელმწიფო სამშენებლო-ტექნიკურ ინსპექტირებას ამხანაგობის წარმომადგენლის მონაწილეობით.',
          ],
        },
      },
    ],
    consent: 'ვადასტურებ, რომ გავეცანი და ვეთანხმები შპს „რედკოსა“ და საქართველოს ეკონომიკისა და მდგრადი განვითარების სამინისტროში გასაგზავნი წერილების შინაარსს და უფლებამოსილებას ვანიჭებ ბმა „ალპიკის“ თავმჯდომარეს ალექსი სიმონიშვილს, წარადგინოს ეს მიმართვები და დაიცვას ამხანაგობის ინტერესები.',
  },
  en: {
    title: 'Letters to Red-Co LLC and the Ministry of Economy',
    summary: 'The Association is preparing two letters to the developer and a petition to the Ministry of Economy and Sustainable Development (Spatial and Urban Development Agency; Technical and Construction Supervision Agency). The chairman prepares the final text before sending.',
    sections: [
      {
        tone: 'danger', tag: 'Letter 1 · Red-Co LLC',
        title: 'Blocked access road, fire safety and noise',
        items: [
          { lead: 'Evacuation and access road', text: 'The building originally had two access roads. One of them is fully blocked and occupied by private commercial kiosks and a stage. The plot (71.62.58.548) has no officially registered access road, and the only remaining access is a dead end. This contradicts Section 915 of Government of Georgia Resolution No. 41 (planning of access roads for fire and rescue vehicles).' },
          { lead: 'Noise from the stage and kiosks', text: 'The stage and kiosks on the blocked road produce constant excessive noise, which worsens conditions for residents and guests and disrupts the normal operation of the building.' },
        ],
        demands: {
          title: 'Demands',
          items: [
            'A written explanation of who authorised blocking the road and who bears legal liability in case of fire.',
            'Immediate removal of the kiosks and stage from the road.',
            'An end to the source of the noise.',
          ],
          after: 'Otherwise the Association will apply to the Emergency Management Service and the Municipal Inspection.',
        },
      },
      {
        tone: 'neutral', tag: 'Letter 2 · Red-Co LLC',
        title: 'Construction, design and technical safety violations',
        intro: 'In the Association\'s view, the building deviates from the permit in ways that cannot be legalised by amending the design alone, without physical remediation.',
        items: [
          { lead: 'Flammable facade', text: 'The building is clad with brick-textured XPS insulation, which Resolution No. 41 prohibits because of rapid fire spread.' },
          { lead: 'Fire systems', text: 'Fire-engineering equipment and networks are not working.' },
          { lead: 'Number of apartments', text: 'The 60 m² apartments in the design were split in two, doubling the number of units and overloading escape routes and utilities.' },
          { lead: 'Elevators', text: 'Elevators stop at the parking level (−1) and do not serve the commercial floors −2 and −3 shown in the design.' },
          { lead: 'Sewage under sprinklers', text: 'On the parking level, sewage pipes run under the sprinklers, which Resolution No. 41 does not allow.' },
          { lead: 'Water, parking, facade', text: 'Because of defects in the water network, the water utility refuses to connect the building, leaving it dependent on Red-Co\'s supply; the rear facade at parking level is unclad; the parking floor is unfinished and unmarked; rainwater pipes are loose or missing.' },
        ],
      },
      {
        tone: 'info', tag: 'Petition · Ministry of Economy',
        title: 'Return of common property and participation in proceedings',
        items: [
          { lead: 'Common areas and boiler room', text: 'Common areas required by Resolution No. 41 (restrooms, service shafts, meter rooms, ski-depots) and the boiler room, which also supplies hot water to other buildings, are registered to Red-Co LLC. The Association asks for their transfer to HOA “Alpiki”.' },
        ],
        demands: {
          title: 'We ask the Ministry to',
          items: [
            'Include HOA “Alpiki” as an interested party in all administrative proceedings concerning plot 71.62.58.548.',
            'Not approve an amended design or commission the building without the Association\'s consent and physical remediation of the violations.',
            'Carry out an on-site state technical inspection with an Association representative present.',
          ],
        },
      },
    ],
    consent: 'I confirm that I have read and agree to the contents of the letters to Red-Co LLC and the Ministry of Economy and Sustainable Development of Georgia, and I authorise the Chairman of HOA “Alpiki”, Aleksi Simonishvili, to submit them and represent the Association\'s interests.',
  },
  ru: {
    title: 'Письма в ООО «Ред-Ко» и Министерство экономики',
    summary: 'Товарищество готовит два письма застройщику и заявление в Министерство экономики и устойчивого развития (Агентство пространственного и градостроительного развития; Агентство технического и строительного надзора). Окончательный текст председатель оформляет перед отправкой.',
    sections: [
      {
        tone: 'danger', tag: 'Письмо №1 · ООО «Ред-Ко»',
        title: 'Перекрытая подъездная дорога, пожарная безопасность и шум',
        items: [
          { lead: 'Эвакуационная и подъездная дорога', text: 'Изначально у корпуса было две подъездные дороги. Одна из них полностью перекрыта, на ней в коммерческих целях размещены частные киоски и сцена. У участка (71.62.58.548) нет официально зарегистрированной подъездной дороги, а единственный оставшийся подъезд тупиковый. Это противоречит подразделу 915 Постановления Правительства Грузии №41 (планирование подъездов для пожарной и спасательной техники).' },
          { lead: 'Шум от сцены и киосков', text: 'Сцена и киоски на перекрытой дороге постоянно создают чрезмерный шум, что ухудшает условия жильцов и отдыхающих и мешает нормальной работе корпуса.' },
        ],
        demands: {
          title: 'Требования',
          items: [
            'Письменное разъяснение: кто разрешил перекрыть дорогу и кто несёт правовую ответственность в случае пожара.',
            'Немедленно освободить дорогу от киосков и сцены.',
            'Устранить источник шума.',
          ],
          after: 'В противном случае товарищество обратится в Службу управления чрезвычайными ситуациями и муниципальную инспекцию.',
        },
      },
      {
        tone: 'neutral', tag: 'Письмо №2 · ООО «Ред-Ко»',
        title: 'Строительные, проектные и технические нарушения',
        intro: 'По позиции товарищества, корпус построен с отступлениями от разрешения, которые нельзя узаконить одной корректировкой проекта без физического устранения.',
        items: [
          { lead: 'Горючий фасад', text: 'Здание облицовано утеплителем XPS с фактурой кирпича, что запрещено Постановлением №41 из-за быстрого распространения огня.' },
          { lead: 'Пожарные системы', text: 'Пожарно-инженерное оборудование и сети не работают.' },
          { lead: 'Число квартир', text: 'Предусмотренные проектом квартиры по 60 м² разделены надвое; число квартир удвоено, что перегружает эвакуационные пути и инженерные сети.' },
          { lead: 'Лифты', text: 'Лифты доходят только до паркинга (−1) и не спускаются на коммерческие этажи −2 и −3, заложенные в проекте.' },
          { lead: 'Канализация под спринклерами', text: 'На этаже паркинга под спринклерами проложены канализационные трубы, что Постановлением №41 не допускается.' },
          { lead: 'Вода, паркинг, фасад', text: 'Из-за дефектов водопровода водоканал отказывается подключать дом, и он зависит от воды «Ред-Ко»; задний фасад на уровне паркинга не облицован; пол паркинга не завершён и не размечен; водостоки не закреплены или отсутствуют.' },
        ],
      },
      {
        tone: 'info', tag: 'Заявление · Министерство экономики',
        title: 'Возврат общего имущества и участие в производстве',
        items: [
          { lead: 'Общие помещения и котельная', text: 'Обязательные по Постановлению №41 общие помещения (санузлы, шахты коммуникаций, помещения счётчиков, ски-депо) и котельная, снабжающая горячей водой и другие корпуса, зарегистрированы на ООО «Ред-Ко». Товарищество требует передать их в собственность ТСЖ «Алпики».' },
        ],
        demands: {
          title: 'Просим Министерство',
          items: [
            'Включить ТСЖ «Алпики» заинтересованной стороной во все административные производства по участку 71.62.58.548.',
            'Не согласовывать корректировку проекта и не принимать здание в эксплуатацию без согласия товарищества и физического устранения нарушений.',
            'Провести государственную строительно-техническую проверку на месте с участием представителя товарищества.',
          ],
        },
      },
    ],
    consent: 'Подтверждаю, что ознакомился(-ась) и согласен(-на) с содержанием писем в ООО «Ред-Ко» и Министерство экономики и устойчивого развития Грузии, и уполномочиваю председателя ТСЖ «Алпики» Алекси Симонишвили подать эти обращения и представлять интересы товарищества.',
  },
};
