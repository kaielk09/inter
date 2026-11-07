# Purple AI — Inter

Strona kont użytkowników i bramka do istniejącego, wspólnego Purple AI API z repozytorium https://github.com/kaielk09/Ai.

## Funkcje w pierwszej wersji

- Rejestracja i logowanie przez e-mail oraz hasło.
- Aktywacja konta linkiem wysłanym przez SMTP.
- Jeden aktywny token API na konto; regeneracja unieważnia poprzedni.
- Tygodniowa pula testowa ustawiana przez `WEEKLY_TEST_TOKENS`.
- Sprawdzanie i odejmowanie limitu po stronie serwera.
- Panel z saldem, tokenem API i prostym czatem testowym.
- Pakiety dodatkowych tokenów konfigurowane przez środowisko.
- Integracja płatności TostHost: tworzenie transakcji i webhook, który ponownie sprawdza status transakcji u dostawcy przed dodaniem tokenów.

## Uruchomienie

Wymagany Node.js 20 lub nowszy.

```bash
npm install
cp .env.example .env
npm start
```

Na Windows skopiuj `.env.example` do `.env` ręcznie.

## Konfiguracja

Wypełnij w `.env`:
- `PUBLIC_URL` — publiczny adres strony.
- `JWT_SECRET` i `WEBHOOK_SECRET` — dwa różne, losowe sekrety (minimum 32 znaki).
- `PURPLE_API_URL` — bazowy adres działającego serwera z repozytorium Purple AI.
- `PURPLE_API_KEY` — prywatny klucz głównego API Purple AI; nigdy nie umieszczaj go w frontendzie.
- `WEEKLY_TEST_TOKENS` — liczba darmowych tokenów testowych przyznawanych na start i odnawianych co 7 dni.
- SMTP — dane serwera pocztowego do wysyłania linków aktywacyjnych.
- TostHost — klucz API płatności.
- `PAYMENT_PACKAGES_JSON` — własne pakiety, ceny w PLN i liczby tokenów. Przykład składni (to tylko przykład, nie ustalony cennik):

```json
{"small":{"label":"Pakiet mały","amount":5.00,"credits":5000}}
```

## API dla programistów

Klient używa tokenu użytkownika w nagłówku:

```
Authorization: Bearer purple_TWÓJ_TOKEN
Content-Type: application/json
```

Endpoint:
`POST /v1/chat`

Przykładowe body:

```json
{
  "messages": [
    {"role": "user", "content": "Cześć Purple AI"}
  ],
  "max_new_tokens": 160
}
```

Serwer sprawdza limit, a następnie przekazuje żądanie do wspólnego API modelu. Główny klucz modelu nie jest ujawniany klientom.

## Płatności TostHost

Kod używa API:
- `POST /transactions/create`
- `GET /transactions/status/{transactionId}`
- webhook z polami `transactionId`, `status`, `customReference`, `isSandbox`.

Webhook ma dodatkowy losowy sekret w adresie URL i nie ufa samemu statusowi z powiadomienia — ponownie pobiera status transakcji przez autoryzowane API. Tokeny są dodawane tylko raz, gdy zweryfikowana transakcja ma status `PAID`.

Przed uruchomieniem produkcyjnym należy porównać pola odpowiedzi statusu z aktualną dokumentacją TostHost i wykonać transakcję testową w trybie sandbox.

## Ważne ograniczenia

- To pierwsza wersja szkieletu aplikacji. Nie jest jeszcze wdrożona ani przetestowana na serwerze TostHost.
- SMTP, adres API Purple AI, klucze i pakiety muszą być skonfigurowane.
- SQLite wymaga trwałego katalogu danych na hostingu.
- Licznik kosztu jest szacunkowy: liczy wejście orientacyjnie (około 4 znaki na token), a wyjście na podstawie limitu/odpowiedzi. Dla dokładnego rozliczania model powinien zwracać rzeczywiste tokeny wejścia i wyjścia.
- API Purple AI musi być dostępne z serwera tej strony.
