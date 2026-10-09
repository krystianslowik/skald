// Package supervisor is a minimal hand-rolled XML-RPC client for the four
// supervisord methods the agent needs. It covers the subset of XML-RPC that
// supervisord actually emits: string, int/i4, boolean, double, struct, array,
// untyped values, and faults.
package supervisor

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Fault codes from supervisor/xmlrpc.py that the client treats specially.
const (
	FaultBadName        = 10
	FaultAlreadyStarted = 60
	FaultNotRunning     = 70
)

// Fault is an XML-RPC <fault> response.
type Fault struct {
	Code   int
	String string
}

func (f *Fault) Error() string {
	return fmt.Sprintf("supervisor fault %d: %s", f.Code, f.String)
}

// IsFault reports whether err is a Fault with the given code.
func IsFault(err error, code int) bool {
	var f *Fault
	return errors.As(err, &f) && f.Code == code
}

// encodeCall marshals a methodCall. Params may be string, bool, or int.
func encodeCall(method string, params ...any) ([]byte, error) {
	var b bytes.Buffer
	b.WriteString(`<?xml version="1.0"?><methodCall><methodName>`)
	xml.EscapeText(&b, []byte(method))
	b.WriteString(`</methodName><params>`)
	for _, p := range params {
		b.WriteString(`<param><value>`)
		switch v := p.(type) {
		case string:
			b.WriteString(`<string>`)
			xml.EscapeText(&b, []byte(v))
			b.WriteString(`</string>`)
		case bool:
			if v {
				b.WriteString(`<boolean>1</boolean>`)
			} else {
				b.WriteString(`<boolean>0</boolean>`)
			}
		case int:
			fmt.Fprintf(&b, `<int>%d</int>`, v)
		default:
			return nil, fmt.Errorf("xmlrpc: unsupported param type %T", p)
		}
		b.WriteString(`</value></param>`)
	}
	b.WriteString(`</params></methodCall>`)
	return b.Bytes(), nil
}

type xValue struct {
	String  *string  `xml:"string"`
	Int     *string  `xml:"int"`
	I4      *string  `xml:"i4"`
	Boolean *string  `xml:"boolean"`
	Double  *string  `xml:"double"`
	Struct  *xStruct `xml:"struct"`
	Array   *xArray  `xml:"array"`
	Text    string   `xml:",chardata"`
}

type xStruct struct {
	Members []struct {
		Name  string `xml:"name"`
		Value xValue `xml:"value"`
	} `xml:"member"`
}

type xArray struct {
	Values []xValue `xml:"data>value"`
}

type xResponse struct {
	XMLName xml.Name `xml:"methodResponse"`
	Params  []xValue `xml:"params>param>value"`
	Fault   *xValue  `xml:"fault>value"`
}

// decodeResponse parses a methodResponse into a Go value (string, int, bool,
// float64, map[string]any, []any) or a *Fault error.
func decodeResponse(body []byte) (any, error) {
	var r xResponse
	if err := xml.Unmarshal(body, &r); err != nil {
		return nil, fmt.Errorf("xmlrpc: decode: %w", err)
	}
	if r.Fault != nil {
		v, err := r.Fault.native()
		if err != nil {
			return nil, err
		}
		m, _ := v.(map[string]any)
		code, _ := m["faultCode"].(int)
		msg, _ := m["faultString"].(string)
		return nil, &Fault{Code: code, String: msg}
	}
	if len(r.Params) == 0 {
		return nil, nil
	}
	return r.Params[0].native()
}

func (v xValue) native() (any, error) {
	switch {
	case v.String != nil:
		return *v.String, nil
	case v.Int != nil:
		return strconv.Atoi(strings.TrimSpace(*v.Int))
	case v.I4 != nil:
		return strconv.Atoi(strings.TrimSpace(*v.I4))
	case v.Boolean != nil:
		return strings.TrimSpace(*v.Boolean) == "1", nil
	case v.Double != nil:
		return strconv.ParseFloat(strings.TrimSpace(*v.Double), 64)
	case v.Struct != nil:
		m := make(map[string]any, len(v.Struct.Members))
		for _, mem := range v.Struct.Members {
			x, err := mem.Value.native()
			if err != nil {
				return nil, err
			}
			m[mem.Name] = x
		}
		return m, nil
	case v.Array != nil:
		out := make([]any, 0, len(v.Array.Values))
		for _, e := range v.Array.Values {
			x, err := e.native()
			if err != nil {
				return nil, err
			}
			out = append(out, x)
		}
		return out, nil
	default:
		// Untyped <value>text</value> is a string per the spec.
		return v.Text, nil
	}
}
