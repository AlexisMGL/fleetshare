# Fleetshare

This project is a small Express server used to stream video through GStreamer.

## Running with Docker

A `Dockerfile` is provided that installs GStreamer and all required plugins so
`gst-launch-1.0` is available inside the container.

Build the image and run the server with:

```bash
docker build -t fleetshare .
docker run -p 3000:3000 fleetshare
```

The application will be available on `http://localhost:3000`.

## Local commands

If you previously ran the server with:

```bash
npm install
node server.js
```

Replace those commands with the Docker commands above. The container installs the
Node dependencies and GStreamer automatically.
