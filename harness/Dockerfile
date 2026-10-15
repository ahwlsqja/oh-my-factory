COPY main.mjs matcher.mjs /app/
# The context files are 0600 on the host; the sandbox user below must be able to read them.
# This runs before the user switch, so it assumes the pinned base image defaults to root (true for the node base).
RUN chmod 0644 /app/main.mjs /app/matcher.mjs
WORKDIR /app
USER 65532:65532
