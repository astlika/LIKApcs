**likalivepcs v1 — versioni 1.1.0**: njoftime të reja për kompjuterët, për shitjet që duhen parë dhe për ditën. Instalohet mbi versionin 1.0.0; kyçja dhe cilësimet mbeten.

**Kompjuterët**

- **Kush i ndezi**: “Arta e ndezi PC 05”, “Arta i ndezi të gjitha PC-të (12)”.
- **Kur ndizen dhe fiken vërtet**: “PC 03 u ndez”. Kur ndizen disa njëri pas tjetrit, është një njoftim i vetëm që rritet: “U ndezën 12 PC”.
- **Fikje dhe rinisje nga Admini**: kush dhe cilin PC.
- **PC e fikur gjatë seancës**, si alarm.
- **Seancat me emrin e vet**: “Arta nisi PC 05 · 60 min · 2.00 €”, “Arta zgjati PC 05 · +30 min · 1.00 €”, “Arta mbylli PC 02 · 1 h 05 min · 2.17 €”.
- **Koha po mbaron**: “PC 05: mbeten 5 min” (minutat i caktoni vetë), pastaj “PC 05: koha mbaroi”.
- **Rezervim që fillon së shpejti**, në kohën e kujtesës që ka rezervimi.

**Shitjet**

- **Zbritje**: kush e dha dhe sa, në të njëjtin njoftim me shitjen.
- **Shitje nën kosto**, me humbjen.
- **Shitje e madhe**, mbi shumën që caktoni, dhe **asnjë shitje prej kohësh** brenda orarit të punës. Këto dy janë të fikura derisa t’i ndizni.
- Fitimi i një shitjeje me zbritje del i saktë: zbritja hiqet nga fitimi.

**Dita**

- **Qarkullimi kaloi 100 €, 200 €…** — shumën e caktoni vetë.
- **Përmbledhja e ditës** në orën që zgjidhni: qarkullimi, fitimi, kush sa shiti, shpenzimet, arka.
- **Borxhet që skadojnë sot**, një herë në ditë.

**Cilësimet**

- Çdo lloj njoftimi ka çelësin e vet, dhe brenda llojeve ka çelësa më të imët, me minutat, shumat dhe orët e tyre.
- **Orët e qeta**: njoftimet vijnë, por pa zë (p.sh. 23:30–08:00).

Aplikacioni vetëm lexon: prej tij nuk ndryshohet asgjë në lokal. Punon me LIKApcs Server 0.33.4; serveri nuk ndryshon.

**Përditësimi nga 1.0.0**

Shkarkoni skedarin `.apk` më poshtë në telefon dhe hapeni: instalohet mbi versionin e vjetër. Nuk duhet hyrë përsëri.

**Instalimi për herë të parë**

1. Shkarkoni skedarin `.apk` më poshtë në telefon dhe hapeni. Android pyet një herë nëse lejohet instalimi nga ky burim: lejojeni.
2. Hapni **likalivepcs v1** dhe hyni: adresa e kompjuterit kryesor (p.sh. `192.168.1.10:4700`), emri i përdoruesit, e-maili dhe fjalëkalimi i llogarisë së pronarit. Butoni me lupë e kërkon adresën në Wi-Fi të lokalit; nëse nuk e gjen, shkruajeni me dorë — adresat janë te Admin › Kopjet rezervë › “Serveri dhe rrjeti”. Llogaria duhet të ketë e-mail të ruajtur te Admin › Punonjësit.
3. Lejoni **njoftimet** dhe **punën në sfond** kur aplikacioni i kërkon. Puna në sfond duhet edhe që “koha po mbaron” dhe përmbledhja e ditës të vijnë në minutën e duhur.
4. Te telefonat realme: Cilësimet › Aplikacionet › likalivepcs › Përdorimi i baterisë — ndizni “Lejo aktivitetin në sfond” dhe “Lejo nisjen automatike”.

Jashtë lokalit aplikacioni punon me Tailscale (në telefon dhe në kompjuterin kryesor): te adresa e serverit shkruani adresën Tailscale të kompjuterit.
