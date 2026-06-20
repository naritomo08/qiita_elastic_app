FROM ruby:3.4-alpine

RUN gem install webrick --no-document
WORKDIR /app
COPY backend_ruby/*.rb .
RUN for f in *.rb; do ruby -c "$f"; done

EXPOSE 5000
CMD ["ruby", "server.rb"]
