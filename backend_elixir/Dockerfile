FROM elixir:1.17-alpine AS build

RUN apk add --no-cache build-base git

WORKDIR /app

COPY backend_elixir/mix.exs ./
COPY backend_elixir/config ./config
RUN mix local.hex --force && \
    mix local.rebar --force && \
    MIX_ENV=prod mix deps.get && \
    MIX_ENV=prod mix deps.compile

COPY backend_elixir/lib ./lib
COPY backend_elixir/test ./test
RUN MIX_ENV=test mix deps.get && \
    MIX_ENV=test mix test && \
    MIX_ENV=prod mix compile && \
    MIX_ENV=prod mix release

FROM elixir:1.17-alpine

RUN apk add --no-cache libstdc++ openssl ncurses-libs ca-certificates

WORKDIR /app
COPY --from=build /app/_build/prod/rel/qiita_search_backend ./

ENV HOME=/app
EXPOSE 5021

CMD ["bin/qiita_search_backend", "start"]
