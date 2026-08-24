/**
 * Clinic booking widget - vanilla JS, no build step (a WordPress plugin
 * asset should run as-is in the browser). Talks only to this plugin's own
 * REST proxy (ClinicBookingConfig.restUrl), never to the booking API
 * directly - the proxy is what attaches the tenant's API key server-side.
 *
 * No booking logic lives here either: available dates/times, whether a
 * slot can still be held, and appointment state all come straight from
 * the API responses. This file only renders what it's told and forwards
 * what the patient submits (docs/API.md §5).
 */
(function () {
  "use strict";

  var DAYS_AHEAD = 60;

  function uuidv4() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    // Fallback for older browsers - not cryptographically strong, but this
    // is only ever used as an idempotency key, not a security token.
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function localDateKey(iso) {
    return new Date(iso).toLocaleDateString("en-CA");
  }

  function localTimeLabel(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (key) {
      if (key === "class") node.className = attrs[key];
      else if (key === "text") node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  /**
   * WordPress's REST URL is only a clean path (".../wp-json/...") when
   * pretty permalinks are on. With the default "plain" permalink setting
   * (a fresh install, like this one), rest_url() instead returns a
   * query-string URL ("...?rest_route=/clinic-booking/v1"), which already
   * has a "?" in it - naively appending "?clinicId=..." after that would
   * add a second "?", which isn't a query-string delimiter in URLs, so
   * everything after the first "?" is worked correctly but a second "?"
   * corrupts the intended query and 404s. This must always check for an
   * existing "?" and use "&" in that case.
   */
  function buildUrl(path, params) {
    var url = window.ClinicBookingConfig.restUrl + path;
    var pairs = [];
    Object.keys(params || {}).forEach(function (key) {
      var value = params[key];
      if (value !== undefined && value !== null && value !== "") {
        pairs.push(encodeURIComponent(key) + "=" + encodeURIComponent(value));
      }
    });
    if (pairs.length === 0) return url;
    return url + (url.indexOf("?") >= 0 ? "&" : "?") + pairs.join("&");
  }

  function apiFetch(path, options) {
    options = options || {};
    var headers = { "Content-Type": "application/json" };
    if (options.method && options.method !== "GET") {
      headers["X-WP-Nonce"] = window.ClinicBookingConfig.nonce;
    }
    return fetch(buildUrl(path, options.params), {
      method: options.method || "GET",
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: "same-origin",
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) {
          var message = (body && body.error && body.error.message) || res.statusText;
          var err = new Error(message);
          err.body = body;
          err.status = res.status;
          throw err;
        }
        return body;
      });
    });
  }

  function Widget(root) {
    this.root = root;
    this.state = {
      clinics: [],
      clinicId: window.ClinicBookingConfig.clinicId || "",
      doctors: [],
      doctorId: "",
      services: [],
      serviceId: "",
      slotsByDate: {},
      selectedDate: "",
      selectedSlotIso: "",
      appointment: null,
      error: "",
      step: "loading",
    };
    this.load();
  }

  Widget.prototype.setState = function (patch) {
    Object.assign(this.state, patch);
    this.render();
  };

  Widget.prototype.load = function () {
    var self = this;
    apiFetch("/clinics")
      .then(function (data) {
        var clinics = data.clinics || [];
        var clinicId = self.state.clinicId || (clinics[0] && clinics[0].id) || "";
        self.setState({ clinics: clinics, clinicId: clinicId, step: clinicId ? "doctor" : "clinic" });
        if (clinicId) self.loadDoctorsAndServices(clinicId);
      })
      .catch(function (err) {
        self.setState({ error: err.message, step: "error" });
      });
  };

  Widget.prototype.loadDoctorsAndServices = function (clinicId) {
    var self = this;
    Promise.all([
      apiFetch("/doctors", { params: { clinicId: clinicId } }),
      apiFetch("/services", { params: { clinicId: clinicId } }),
    ])
      .then(function (results) {
        var doctors = results[0].doctors || [];
        var services = results[1].services || [];
        self.setState({
          doctors: doctors,
          services: services,
          doctorId: doctors[0] ? doctors[0].id : "",
          serviceId: services[0] ? services[0].id : "",
          step: "doctor",
        });
        if (doctors[0] && services[0]) self.loadAvailability();
      })
      .catch(function (err) {
        self.setState({ error: err.message, step: "error" });
      });
  };

  Widget.prototype.loadAvailability = function () {
    var self = this;
    if (!this.state.doctorId || !this.state.serviceId) return;
    var from = new Date();
    var to = new Date(from.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);

    apiFetch("/availability", {
      params: {
        doctorId: this.state.doctorId,
        serviceId: this.state.serviceId,
        from: from.toISOString(),
        to: to.toISOString(),
      },
    })
      .then(function (data) {
        var byDate = {};
        (data.slots || []).forEach(function (slot) {
          var key = localDateKey(slot.startAt);
          (byDate[key] = byDate[key] || []).push(slot);
        });
        var firstDate = Object.keys(byDate).sort()[0] || "";
        self.setState({ slotsByDate: byDate, selectedDate: firstDate, selectedSlotIso: "", step: "slot" });
      })
      .catch(function (err) {
        self.setState({ error: err.message, step: "error" });
      });
  };

  Widget.prototype.holdSlot = function (phone, fullName) {
    var self = this;
    this.setState({ error: "", busy: true });
    apiFetch("/hold", {
      method: "POST",
      body: {
        clinicId: this.state.clinicId,
        doctorId: this.state.doctorId,
        serviceId: this.state.serviceId,
        startAt: this.state.selectedSlotIso,
        patient: { phone: phone, fullName: fullName },
        idempotencyKey: uuidv4(),
      },
    })
      .then(function (appointment) {
        self.setState({ appointment: appointment, step: "confirm", busy: false });
      })
      .catch(function (err) {
        // A slot that just got taken by someone else - re-fetch and let the patient pick again.
        if (err.status === 409) {
          self.loadAvailability();
        }
        self.setState({ error: err.message, busy: false });
      });
  };

  Widget.prototype.confirmAppointment = function () {
    var self = this;
    this.setState({ error: "", busy: true });
    apiFetch("/confirm", {
      method: "POST",
      body: { appointmentId: this.state.appointment.id, idempotencyKey: uuidv4() },
    })
      .then(function (appointment) {
        self.setState({ appointment: appointment, step: "done", busy: false });
      })
      .catch(function (err) {
        self.setState({ error: err.message, busy: false });
      });
  };

  Widget.prototype.render = function () {
    var s = this.state;
    this.root.innerHTML = "";
    var container = el("div", { class: "cbw-container" });

    if (s.error) {
      container.appendChild(el("p", { class: "cbw-error", text: s.error }));
    }

    if (s.step === "loading") {
      container.appendChild(el("p", { text: "Loading..." }));
    } else if (s.step === "clinic") {
      container.appendChild(this.renderClinicPicker());
    } else if (s.step === "doctor" || s.step === "slot") {
      container.appendChild(this.renderPickers());
      if (s.step === "slot") container.appendChild(this.renderSlotPicker());
    } else if (s.step === "confirm") {
      container.appendChild(this.renderConfirm());
    } else if (s.step === "done") {
      container.appendChild(this.renderDone());
    } else if (s.step === "error") {
      container.appendChild(el("p", { text: "Something went wrong. Please refresh and try again." }));
    }

    this.root.appendChild(container);
  };

  Widget.prototype.renderClinicPicker = function () {
    var self = this;
    var select = el("select", { class: "cbw-select" });
    this.state.clinics.forEach(function (c) {
      select.appendChild(el("option", { value: c.id, text: c.name }));
    });
    select.addEventListener("change", function () {
      self.setState({ clinicId: select.value, step: "doctor" });
      self.loadDoctorsAndServices(select.value);
    });
    return el("div", { class: "cbw-field" }, [el("label", { text: "Choose a clinic" }), select]);
  };

  Widget.prototype.renderPickers = function () {
    var self = this;
    var wrap = el("div", { class: "cbw-pickers" });

    var doctorSelect = el("select", { class: "cbw-select" });
    this.state.doctors.forEach(function (d) {
      var opt = el("option", { value: d.id, text: d.displayName + (d.specialty ? " (" + d.specialty + ")" : "") });
      if (d.id === self.state.doctorId) opt.setAttribute("selected", "selected");
      doctorSelect.appendChild(opt);
    });
    doctorSelect.addEventListener("change", function () {
      self.setState({ doctorId: doctorSelect.value });
      self.loadAvailability();
    });

    var serviceSelect = el("select", { class: "cbw-select" });
    this.state.services.forEach(function (svc) {
      var opt = el("option", { value: svc.id, text: svc.name + " (" + svc.durationMinutes + "m)" });
      if (svc.id === self.state.serviceId) opt.setAttribute("selected", "selected");
      serviceSelect.appendChild(opt);
    });
    serviceSelect.addEventListener("change", function () {
      self.setState({ serviceId: serviceSelect.value });
      self.loadAvailability();
    });

    wrap.appendChild(el("div", { class: "cbw-field" }, [el("label", { text: "Doctor" }), doctorSelect]));
    wrap.appendChild(el("div", { class: "cbw-field" }, [el("label", { text: "Service" }), serviceSelect]));
    return wrap;
  };

  Widget.prototype.renderSlotPicker = function () {
    var self = this;
    var wrap = el("div", { class: "cbw-slot-picker" });

    var dates = Object.keys(this.state.slotsByDate).sort();
    if (dates.length === 0) {
      wrap.appendChild(el("p", { text: "No open slots in the next " + DAYS_AHEAD + " days. Please try a different doctor or service." }));
      return wrap;
    }

    var dateInput = el("input", { type: "date", class: "cbw-date", value: this.state.selectedDate, min: dates[0], max: dates[dates.length - 1] });
    dateInput.addEventListener("change", function () {
      self.setState({ selectedDate: dateInput.value, selectedSlotIso: "" });
    });
    wrap.appendChild(el("div", { class: "cbw-field" }, [el("label", { text: "Date" }), dateInput]));

    var daySlots = this.state.slotsByDate[this.state.selectedDate] || [];
    if (daySlots.length === 0) {
      wrap.appendChild(el("p", { class: "cbw-hint", text: "No open slots on this date - pick another date." }));
    } else {
      var grid = el("div", { class: "cbw-slot-grid" });
      daySlots.forEach(function (slot) {
        var btn = el("button", { type: "button", class: "cbw-slot-button", text: localTimeLabel(slot.startAt) });
        if (slot.startAt === self.state.selectedSlotIso) btn.classList.add("cbw-slot-selected");
        btn.addEventListener("click", function () {
          self.setState({ selectedSlotIso: slot.startAt });
        });
        grid.appendChild(btn);
      });
      wrap.appendChild(grid);
    }

    if (this.state.selectedSlotIso) {
      wrap.appendChild(this.renderPatientForm());
    }

    return wrap;
  };

  Widget.prototype.renderPatientForm = function () {
    var self = this;
    var form = el("form", { class: "cbw-patient-form" });
    var phoneInput = el("input", { type: "tel", placeholder: "Phone (+91...)", required: "required" });
    var nameInput = el("input", { type: "text", placeholder: "Full name", required: "required" });
    var submitBtn = el("button", { type: "submit", text: this.state.busy ? "Booking..." : "Hold this slot" });
    if (this.state.busy) submitBtn.setAttribute("disabled", "disabled");

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      self.holdSlot(phoneInput.value.trim(), nameInput.value.trim());
    });

    form.appendChild(el("div", { class: "cbw-field" }, [el("label", { text: "Phone" }), phoneInput]));
    form.appendChild(el("div", { class: "cbw-field" }, [el("label", { text: "Full name" }), nameInput]));
    form.appendChild(submitBtn);
    return form;
  };

  Widget.prototype.renderConfirm = function () {
    var self = this;
    var appt = this.state.appointment;
    var wrap = el("div", { class: "cbw-confirm" });
    wrap.appendChild(
      el("p", { text: "Confirm your appointment on " + new Date(appt.startAt).toLocaleString() + "?" })
    );
    var confirmBtn = el("button", { type: "button", class: "cbw-primary", text: this.state.busy ? "Confirming..." : "Confirm" });
    if (this.state.busy) confirmBtn.setAttribute("disabled", "disabled");
    confirmBtn.addEventListener("click", function () {
      self.confirmAppointment();
    });
    wrap.appendChild(confirmBtn);
    return wrap;
  };

  Widget.prototype.renderDone = function () {
    return el("div", { class: "cbw-done" }, [
      el("p", { text: "You're all set! Your appointment is confirmed." }),
    ]);
  };

  function init() {
    var roots = document.querySelectorAll("[data-clinic-booking-root]");
    roots.forEach(function (root) {
      new Widget(root);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
