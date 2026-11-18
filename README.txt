NAMAZ SVIJET — V3.1 (iPhone, Samsung / Android)

SADRŽAJ
- Kompaktan prikaz svih namaza i izlaska sunca, prilagođen širini i visini ekrana.
- Sabah prikazuje početak i kraj (izlazak sunca).
- Posebna kartica Kibla s proračunom smjera prema Kabi i opcionalnim kompasom.
- GPS praćenje lokacije (nakon dozvole, dok je aplikacija aktivna), ručni izbor grada.
- Metoda računanja, mezheb, lokalne korekcije minuta i opcionalni ručni raspored džamije za odabrani dan.

VAŽNO ZA TAČNOST
AlAdhan vraća IZRAČUNATA vremena, koja se mogu razlikovati od vremena odabrane džamije.
Aplikacija trenutno NE preuzima automatski službene rasporede džamija iz MAWAQIT-a.
Ručni raspored džamije može se unijeti u Postavkama; vrijedi samo za taj dan i lokaciju.
Kompas ovisi o podršci senzora, dozvolama i kalibraciji. Ako nema senzora, prikazuje
geografski azimut kible (stepeni od geografskog sjevera).

OBJAVA
Cloudflare Workers Builds objavljuje promjene s grane design-green-gold-preview
na postojeći Worker namaz-svijetav2. Adresa aplikacije je:
https://namaz-svijetav2.mersad-e1d.workers.dev/
Aplikacija zahtijeva HTTPS za GPS i senzore na telefonu.

TEST
Lokalno provjeren prikaz pri 320x568, 360x640, 375x667, 390x844 i 430x932.
Napomena: prikaz kompasa u stvarnom vremenu treba dodatno testirati na fizičkom
Samsung i iPhone uređaju; preglednik može ograničiti senzore.
