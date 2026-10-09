// Package supervisortest is an httptest-backed fake supervisord XML-RPC
// endpoint for tests in this module.
package supervisortest

import (
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
)

const (
	User = "admin"
	Pass = "secret"
)

// Call is one recorded XML-RPC call.
type Call struct {
	Method string
	Params []string // raw inner text of each <value>
}

// Fake answers getAllProcessInfo with three RUNNING processes and every other
// method with <boolean>1</boolean>, unless a fault is configured for it.
type Fake struct {
	*httptest.Server
	mu     sync.Mutex
	calls  []Call
	faults map[string][2]any // method -> {code, string}
	// Block, if set, is received from before answering stopProcess, so tests
	// can hold a restart in flight.
	Block chan struct{}
}

func New() *Fake {
	f := &Fake{faults: map[string][2]any{}}
	f.Server = httptest.NewServer(http.HandlerFunc(f.handle))
	return f
}

func (f *Fake) URL() string { return f.Server.URL + "/RPC2" }

// Fault makes method return an XML-RPC fault.
func (f *Fake) Fault(method string, code int, msg string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.faults[method] = [2]any{code, msg}
}

func (f *Fake) Calls() []Call {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Call(nil), f.calls...)
}

type methodCall struct {
	Method string `xml:"methodName"`
	Params []struct {
		Inner string `xml:",innerxml"`
	} `xml:"params>param>value"`
}

func (f *Fake) handle(w http.ResponseWriter, r *http.Request) {
	if u, p, ok := r.BasicAuth(); !ok || u != User || p != Pass {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	body, _ := io.ReadAll(r.Body)
	var mc methodCall
	if err := xml.Unmarshal(body, &mc); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	c := Call{Method: mc.Method}
	for _, p := range mc.Params {
		c.Params = append(c.Params, p.Inner)
	}
	f.mu.Lock()
	f.calls = append(f.calls, c)
	fault, hasFault := f.faults[mc.Method]
	block := f.Block
	f.mu.Unlock()

	if mc.Method == "supervisor.stopProcess" && block != nil {
		<-block
	}

	w.Header().Set("Content-Type", "text/xml")
	if hasFault {
		fmt.Fprintf(w, `<?xml version='1.0'?>
<methodResponse><fault><value><struct>
<member><name>faultCode</name><value><int>%d</int></value></member>
<member><name>faultString</name><value><string>%s</string></value></member>
</struct></value></fault></methodResponse>`, fault[0], fault[1])
		return
	}
	if mc.Method == "supervisor.getAllProcessInfo" {
		io.WriteString(w, processInfo)
		return
	}
	io.WriteString(w, `<?xml version='1.0'?><methodResponse><params><param><value><boolean>1</boolean></value></param></params></methodResponse>`)
}

// processInfo mirrors real supervisord output, including an empty <string/>
// and an untyped value.
const processInfo = `<?xml version='1.0'?>
<methodResponse>
<params>
<param>
<value><array><data>
<value><struct>
<member><name>name</name><value><string>valheim-server</string></value></member>
<member><name>group</name><value><string>valheim-server</string></value></member>
<member><name>statename</name><value><string>RUNNING</string></value></member>
<member><name>state</name><value><int>20</int></value></member>
<member><name>start</name><value><int>1791584875</int></value></member>
<member><name>pid</name><value><i4>226</i4></value></member>
<member><name>description</name><value><string>pid 226, uptime 0:10:00</string></value></member>
<member><name>spawnerr</name><value><string></string></value></member>
</struct></value>
<value><struct>
<member><name>name</name><value><string>valheim-updater</string></value></member>
<member><name>group</name><value>valheim-updater</value></member>
<member><name>statename</name><value><string>RUNNING</string></value></member>
<member><name>start</name><value><int>1791584870</int></value></member>
</struct></value>
<value><struct>
<member><name>name</name><value><string>valheim-backup</string></value></member>
<member><name>group</name><value><string>valheim-backup</string></value></member>
<member><name>statename</name><value><string>RUNNING</string></value></member>
<member><name>start</name><value><int>1791584870</int></value></member>
</struct></value>
</data></array></value>
</param>
</params>
</methodResponse>`
