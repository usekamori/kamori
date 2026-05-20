FROM python:3.12-slim
WORKDIR /project
COPY sdks/python ./sdks/python
COPY kamori-demo/flask-service ./kamori-demo/flask-service
WORKDIR /project/kamori-demo/flask-service
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt \
 && pip install /project/sdks/python
ENV FLASK_APP=app.py
CMD ["flask", "run", "--host=0.0.0.0", "--port=5001"]
