FLAG_OUTDATED = -ldflags "-s -w -X main.version=v6.0.0"
FLAG_CURRENT = -ldflags "-s -w -X main.version=v12.0.0"
SRC = program.go
OUT = outdated/node.exe up-to-date/node.exe

all: $(OUT)

clean:
	rm -f $(OUT)

outdated/node.exe: $(SRC)
	GOOS=windows GOARCH=amd64 go build $(FLAG_OUTDATED) -o $@ ./program.go

up-to-date/node.exe: $(SRC)
	GOOS=windows GOARCH=amd64 go build $(FLAG_CURRENT) -o $@ ./program.go

.PHONY: all clean
